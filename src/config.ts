import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type Cluster = { cluster: string; region?: string; pool?: string };
export type Event = {
  action?: string;
  ref?: string;
  ref_type?: string;
  pull_request?: { number: number; head: { ref: string; repo?: { full_name: string } } };
};

export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a nonempty string`);
  return value;
}

export function parseClusters(raw: string): Record<string, Cluster> {
  const entries = object(JSON.parse(raw), "branch-clusters");
  const result: Record<string, Cluster> = Object.create(null);
  const used = new Set<string>();
  for (const [branch, entry] of Object.entries(entries)) {
    text(branch, "branch");
    const data = typeof entry === "string" ? { cluster: entry } : object(entry, `branch-clusters.${branch}`);
    for (const key of Object.keys(data)) if (!["cluster", "region", "pool"].includes(key)) throw new Error(`Unknown branch-clusters field: ${key}`);
    const cluster = text(data.cluster, "cluster");
    if (used.has(cluster)) throw new Error(`Map each cluster to only one branch: ${cluster}`);
    used.add(cluster);
    result[branch] = {
      cluster,
      ...(data.region === undefined ? {} : { region: text(data.region, "region") }),
      ...(data.pool === undefined ? {} : { pool: text(data.pool, "pool") }),
    };
  }
  return result;
}

function integer(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Number(raw);
}

export function previewName(repo: string, branch: string): string {
  const slug = repo.split("/").pop()!.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20);
  const hash = createHash("sha256").update(`${repo.toLowerCase()}\0${branch}`).digest("hex").slice(0, 20);
  return `rv-preview-${slug}-${hash}`;
}

export function readConfig(env: NodeJS.ProcessEnv, event: Event) {
  const repo = text(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const branch = event.pull_request?.head.ref ?? (env.GITHUB_EVENT_NAME === "delete" ? event.ref : env.GITHUB_REF_NAME);
  const workspace = resolve(env.GITHUB_WORKSPACE || process.cwd());
  const flyEnabled = env.FLY_ENABLED || "false";
  if (!["true", "false"].includes(flyEnabled)) throw new Error("fly-enabled must be true or false");
  const cliVersion = env.RIVET_CLI_VERSION || "latest";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(cliVersion)) throw new Error("rivet-cli-version must be an npm version or dist-tag");
  return {
    repo,
    branch: text(branch, "branch"),
    pr: event.pull_request?.number,
    eventName: env.GITHUB_EVENT_NAME || "workflow_dispatch",
    refType: event.ref_type ?? env.GITHUB_REF_TYPE,
    action: event.action,
    fork: !!event.pull_request && event.pull_request.head.repo?.full_name !== repo,
    clusters: parseClusters(env.BRANCH_CLUSTERS || "{}"),
    workspace,
    buildPath: resolve(workspace, env.DOCKER_BUILD_PATH || "."),
    dockerfile: resolve(workspace, env.DOCKERFILE_PATH || "Dockerfile"),
    flyEnabled: flyEnabled === "true",
    flyToken: env.FLY_API_TOKEN || "",
    flyOrg: env.FLY_ORG || "",
    flyRegion: env.FLY_REGION || "iad",
    flyPort: integer(env.FLY_PORT || "8080", "fly-port", 1, 65535),
    flyMemory: integer(env.FLY_MEMORY || "1024", "fly-memory", 256, 16384),
    flyVolumeSize: integer(env.FLY_VOLUME_SIZE || "20", "fly-volume-size", 5, 100),
    cliVersion,
    cliPath: env.RIVET_CLI_PATH || "",
    cloudToken: env.RIVET_CLOUD_TOKEN || "",
    cloudOrg: env.RIVET_ORG || "",
    githubToken: env.GITHUB_TOKEN || "",
  };
}

export type Config = ReturnType<typeof readConfig>;
export type Plan = { kind: "skip"; reason: string } | { kind: "cleanup" } | { kind: "fly" } | { kind: "cloud"; target: Cluster };

export function plan(config: Config): Plan {
  if (config.fork) return { kind: "skip", reason: "Fork pull requests do not receive deployment credentials." };
  if (config.refType === "tag") return { kind: "skip", reason: "Tag events do not deploy." };
  if (!["push", "pull_request", "workflow_dispatch", "delete"].includes(config.eventName)) return { kind: "skip", reason: "Unsupported event." };
  if (config.eventName === "delete" || (config.eventName === "pull_request" && config.action === "closed")) return { kind: "cleanup" };
  if (config.eventName === "pull_request" && !["opened", "synchronize", "reopened"].includes(config.action || "")) return { kind: "skip", reason: "Unsupported pull request action." };
  const target = config.clusters[config.branch];
  if (target) return { kind: "cloud", target };
  if (!config.flyEnabled || !config.flyToken) return { kind: "skip", reason: "Preview deployments are not enabled." };
  return { kind: "fly" };
}
