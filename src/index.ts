import { readFile } from "node:fs/promises";
import { deployCloud } from "./cloud";
import { type Config, readConfig, plan, previewName } from "./config";
import { Fly } from "./fly";
import { output, status } from "./github";

export async function main(config: Config) {
  const selected = plan(config);
  if (selected.kind === "skip") {
    console.log(selected.reason);
    await output({ status: "skipped" });
    await status(config, "skipped", { reason: selected.reason });
    return;
  }
  const cleanup = selected.kind === "cleanup";
  try {
    if (cleanup) {
      const retained = !!config.clusters[config.branch];
      let removed = false;
      // A preview may predate the current branch mapping or enabled switch.
      if (config.flyToken && config.flyOrg) {
        await status(config, "removing");
        await new Fly(config).cleanup();
        removed = true;
      } else if (config.flyEnabled) throw new Error("Preview cleanup needs fly-token and fly-org");
      await output({ status: "closed" });
      await status(config, "closed", { retained, removed, reason: removed ? undefined : "Preview cleanup was not verified because credentials are unavailable." });
      return;
    }
    await status(config, "deploying", { provider: selected.kind === "cloud" ? "rivet" : "fly" });
    if (selected.kind === "cloud") {
      const result = await deployCloud(config, selected.target);
      await output({ status: "ready", provider: "rivet", "build-id": result.buildId, url: result.url });
      await status(config, "ready", { url: result.url || undefined });
    } else {
      const url = await new Fly(config).deploy();
      await output({ status: "ready", provider: "fly", "fly-app": previewName(config.repo, config.branch), url });
      await status(config, "ready", { url });
    }
  } catch (error) {
    await status(config, cleanup ? "cleanup-failed" : "failed");
    throw error;
  }
}

if (import.meta.main) {
  try {
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
    await main(readConfig(process.env, event));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment failed");
    process.exitCode = 1;
  }
}
