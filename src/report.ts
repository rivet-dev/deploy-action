import { readFile } from "node:fs/promises";
import type { Event } from "./config";
import { status } from "./github";

// Independent of deployment configuration so setup/validation failures can report too.
const event: Event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
const cleanup = process.env.GITHUB_EVENT_NAME === "delete" || event.action === "closed";
await status({
  repo: process.env.GITHUB_REPOSITORY!,
  branch: event.pull_request?.head.ref || process.env.GITHUB_REF_NAME || "",
  pr: event.pull_request?.number,
  githubToken: process.env.GITHUB_TOKEN || "",
}, process.env.DEPLOY_CANCELLED === "true" ? "cancelled" : cleanup ? "cleanup-failed" : "failed");
