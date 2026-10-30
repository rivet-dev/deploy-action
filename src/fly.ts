import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, previewName } from "./config";
import { run, type Run } from "./process";

type Machine = { id: string; state: string; region: string };
type App = { name: string; organization: { slug: string } };
type Volume = { id: string; name: string; region: string; state: string; size_gb: number };

export function flyConfig(config: Config) {
  return {
    app: previewName(config.repo, config.branch),
    primary_region: config.flyRegion,
    kill_signal: "SIGTERM",
    kill_timeout: 30,
    env: {
      NODE_ENV: "development",
      PORT: String(config.flyPort),
      // Use RivetKit's standard dev-engine startup and storage resolution.
      RIVETKIT_STORAGE_PATH: "/data",
    },
    http_service: {
      internal_port: config.flyPort,
      force_https: true,
      auto_stop_machines: "stop",
      auto_start_machines: true,
      min_machines_running: 0,
      concurrency: { type: "connections", soft_limit: 20, hard_limit: 25 },
    },
    mounts: [{ source: "rivet_data", destination: "/data", initial_size: `${config.flyVolumeSize}gb` }],
    vm: [{ cpu_kind: "shared", cpus: 1, memory_mb: config.flyMemory }],
  };
}

export class Fly {
  private app: string;
  constructor(private config: Config, private command: Run = run, private request: (url: string, init: RequestInit) => Promise<Response> = fetch) {
    this.app = previewName(config.repo, config.branch);
    if (!config.flyToken || !config.flyOrg) throw new Error("Fly previews need fly-token and fly-org");
  }

  private async api<T>(path: string, method = "GET", body?: unknown): Promise<T | null> {
    const response = await this.request(`https://api.machines.dev/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.flyToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) throw new Error(`Fly ${method} ${path} failed (HTTP ${response.status})`);
    if (response.status === 204) return null;
    const data = await response.text();
    return data ? JSON.parse(data) as T : null;
  }

  private async existing(): Promise<App | null> {
    const app = await this.api<App>(`/apps/${this.app}`);
    if (app && (app.name !== this.app || app.organization.slug !== this.config.flyOrg)) throw new Error("Preview app belongs to a different Fly organization");
    return app;
  }

  private async machines() {
    return (await this.api<Machine[]>(`/apps/${this.app}/machines`) ?? []).filter((m) => m.state !== "destroyed");
  }

  async deploy(): Promise<string> {
    if (!await this.existing()) {
      await this.api("/apps", "POST", { app_name: this.app, org_slug: this.config.flyOrg, network: this.app });
    }
    const machines = await this.machines();
    if (machines.length > 1) throw new Error("Expected at most one preview Machine; reconcile the Fly app before deploying");
    if (machines.some((m) => m.region !== this.config.flyRegion)) throw new Error("Cannot move a preview's local volume to another region; keep fly-region unchanged");
    const volumes = await this.api<Volume[]>(`/apps/${this.app}/volumes`) ?? [];
    if (volumes.some((v) => v.name === "rivet_data" && v.region !== this.config.flyRegion && v.state !== "destroyed")) throw new Error("Preview data is in another region; keep fly-region unchanged");
    const dataVolumes = volumes.filter((v) => v.name === "rivet_data" && v.state !== "destroyed");
    if (dataVolumes.length > 1) throw new Error("Expected one preview data volume; reconcile the Fly app before deploying");
    const volume = dataVolumes[0];
    if (volume && volume.size_gb < this.config.flyVolumeSize) {
      await this.command("flyctl", ["volumes", "extend", volume.id, "--app", this.app, "--size", String(this.config.flyVolumeSize), "--yes"], {
        env: { FLY_API_TOKEN: this.config.flyToken, NO_COLOR: "1" },
      });
    }
    const directory = await mkdtemp(join(tmpdir(), "rivet-preview-"));
    try {
      const configPath = join(directory, "fly.json");
      await writeFile(configPath, JSON.stringify(flyConfig(this.config)));
      // Disable the spare Machine and wait for the updated instance to boot.
      await this.command("flyctl", [
        "deploy", this.config.buildPath, "--app", this.app,
        "--config", configPath, "--dockerfile", this.config.dockerfile,
        "--ha=false", "--strategy", "rolling", "--yes", "--remote-only",
        "--wait-timeout", "5m", "--volume-initial-size", String(this.config.flyVolumeSize),
      ], { cwd: this.config.workspace, env: { FLY_API_TOKEN: this.config.flyToken, NO_COLOR: "1" } });
      const after = await this.machines();
      if (after.length !== 1) throw new Error(`Expected one preview Machine after deploy; found ${after.length}`);
      return `https://${this.app}.fly.dev`;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async cleanup(): Promise<void> {
    if (!await this.existing()) return;
    // Derive the name from the repository and source branch, never from PR comments.
    await this.command("flyctl", ["apps", "destroy", this.app, "--yes"], {
      env: { FLY_API_TOKEN: this.config.flyToken, NO_COLOR: "1" },
    });
  }
}
