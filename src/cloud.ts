import type { Cluster, Config } from "./config";
import { run, type Run } from "./process";

export async function deployCloud(
  config: Config,
  target: Cluster,
  command: Run = run,
): Promise<{ buildId: string; url: string }> {
  if (!config.cloudOrg) throw new Error("Cloud deployments need rivet-org");
  if (!config.cloudToken && !config.githubOidc) throw new Error("Cloud deployments need a Cloud deployment credential: grant the workflow `id-token: write` and add a GitHub Actions trust to the cluster, or set rivet-token (not an Engine admin token)");
  const program = config.cliPath || "bun";
  const prefix = config.cliPath ? [] : ["x", "--package", `@rivetkit/cli@${config.cliVersion}`, "rivet"];
  const options = { cwd: config.workspace, env: { RIVET_CLOUD_TOKEN: config.cloudToken, NO_COLOR: "1" } };
  const cli = (args: string[], quiet = false) => command(program, [...prefix, ...args], { ...options, quiet });
  // The older namespace CLI must never silently deploy to a different target.
  const help = await cli(["deploy", "--help"], true);
  if (!help.includes("--cluster") || !help.includes("--build-context")) {
    throw new Error("This Rivet CLI cannot deploy v3 clusters. Set rivet-cli-version to a release supporting --cluster, or rivet-cli-path to an installed v3 binary.");
  }
  const selection = ["--org", config.cloudOrg, "--cluster", target.cluster];
  const api = async <T>(path: string): Promise<T> => JSON.parse(await cli(["api", path, ...selection], true));
  // Resolve and validate the region before building or changing the pool.
  const regions = await api<{ items: { region: string }[] }>("/v2/clusters/{cluster}/regions");
  const region = target.region ?? (regions.items.length === 1 ? regions.items[0].region : undefined);
  if (!region || !regions.items.some((item) => item.region === region)) {
    throw new Error("Set a mapped region that exists on the cluster; automatic selection requires exactly one region");
  }
  const result = await cli([
    "deploy", ...selection, "--region", region,
    ...(target.pool ? ["--pool", target.pool] : []),
    "--dockerfile", config.dockerfile, "--build-context", config.buildPath, "--yes",
  ]);
  // The CLI writes progress before its final line, which is the build ID.
  const buildId = result.trim().split(/\r?\n/).at(-1) || "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(buildId)) throw new Error("Deployment finished but the Rivet CLI did not return a build ID; inspect the cluster before retrying");
  console.log(`Rivet build: ${buildId}`);
  const pool = await api<{ build_id: string | null; endpoints: { public: string | null } }>(
    `/v2/clusters/{cluster}/regions/${encodeURIComponent(region)}/runner-pools/${encodeURIComponent(target.pool ?? "default")}`,
  );
  if (pool.build_id !== buildId) throw new Error("The pool changed after deployment; inspect concurrent deployments before retrying");
  return { buildId, url: pool.endpoints.public || "" };
}
