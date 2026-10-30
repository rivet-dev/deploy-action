import { appendFile } from "node:fs/promises";
import type { Config } from "./config";

const marker = "<!-- rivet-deploy-v3 -->";
type Comment = { id: number; body: string; user?: { login: string; type: string } };

export type StatusState = "deploying" | "ready" | "failed" | "skipped" | "removing" | "closed" | "cleanup-failed" | "cancelled";
export type StatusDetails = { url?: string; provider?: "rivet" | "fly"; reason?: string; retained?: boolean; removed?: boolean };
export type CommentConfig = Pick<Config, "repo" | "pr" | "branch" | "githubToken">;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/`/g, "&#96;").replace(/[\r\n]/g, " ");
}

export function renderStatus(config: CommentConfig, state: StatusState, details: StatusDetails = {}, runId = process.env.GITHUB_RUN_ID): string {
  const labels: Record<StatusState, string> = {
    deploying: `⏳ Deploying…${details.provider ? ` (${details.provider === "rivet" ? "Rivet" : "Fly"})` : ""}`,
    ready: "✅ Ready",
    failed: "❌ Deployment failed",
    skipped: "⏭️ Skipped",
    removing: "⏳ Removing preview…",
    closed: details.retained || !details.removed ? "PR closed" : "🗑️ Preview removed",
    "cleanup-failed": "❌ Preview removal failed",
    cancelled: "⏹️ Deployment cancelled",
  };
  const actions: string[] = [];
  if (state === "ready" && details.url) {
    const url = new URL(details.url);
    if (url.protocol === "https:" || url.protocol === "http:") {
      url.username = "";
      url.password = "";
      actions.push(`[Open preview](<${url.href.replace(/[<>|]/g, encodeURIComponent)}>)`);
    }
  }
  if (runId) actions.push(`[Logs](https://github.com/${config.repo.split("/").map(encodeURIComponent).join("/")}/actions/runs/${encodeURIComponent(runId)})`);
  const intro = config.pr ? "Rivet preview deployment for this PR." : "Rivet deployment for this branch.";
  const preview = config.pr ? `PR #${config.pr}` : escapeText(config.branch);
  const reason = details.retained ? "The mapped cluster is retained." : details.reason;
  return `${marker}\n${intro}\n\n| Project | Preview | Status | Actions |\n|:---|:---|:---|:---|\n| ${escapeText(config.repo.split("/").pop()!)} | ${preview} | ${labels[state]} | ${actions.join(" · ") || "—"} |${reason ? `\n\n${escapeText(reason)}` : ""}`;
}

export async function status(config: CommentConfig, state: StatusState, details: StatusDetails = {}) {
  const body = renderStatus(config, state, details);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, body.replace(`${marker}\n`, "") + "\n\n");
  if (!config.pr || !config.githubToken) return;
  const repoPath = config.repo.split("/").map(encodeURIComponent).join("/");
  const base = `https://api.github.com/repos/${repoPath}`;
  async function request(path: string, method = "GET", content?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${config.githubToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      body: content === undefined ? undefined : JSON.stringify(content),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub comment request failed (HTTP ${response.status})`);
    return response.json();
  }
  try {
    let existing: Comment | undefined;
    for (let page = 1; page <= 100; page++) {
      const comments = await request(`/issues/${config.pr}/comments?per_page=100&page=${page}`) as Comment[];
      existing = comments.find((c) => c.user?.login === "github-actions[bot]" && c.user.type === "Bot" && (c.body.startsWith(marker) || c.body.startsWith("<!-- rivet-preview-status -->")));
      if (existing || comments.length < 100) break;
    }
    if (existing) await request(`/issues/comments/${existing.id}`, "PATCH", { body });
    else await request(`/issues/${config.pr}/comments`, "POST", { body });
  } catch (error) {
    // Reporting permissions must not turn a successful rollout into a failed deployment.
    console.warn(error instanceof Error ? error.message : "Could not update PR status");
  }
}

export async function output(values: Record<string, string>) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`Invalid output: ${key}`);
    await appendFile(path, `${key}=${value}\n`);
  }
}
