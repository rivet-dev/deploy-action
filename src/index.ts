import fs from "node:fs";
import { execSync } from "node:child_process";

// Environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const RIVET_CLOUD_TOKEN = process.env.RIVET_CLOUD_TOKEN!;
const RIVET_ENGINE_ENDPOINT = process.env.RIVET_ENGINE_ENDPOINT || "https://api.rivet.dev";
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || "";
const GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH || "";
const DOCKER_BUILD_PATH = process.env.DOCKER_BUILD_PATH || ".";
const DOCKERFILE_PATH = process.env.DOCKERFILE_PATH || "Dockerfile";
const GITHUB_SHA = process.env.GITHUB_SHA || "latest";

function readGitHubEventPayload(): any | null {
	if (!GITHUB_EVENT_PATH) return null;
	try {
		const raw = fs.readFileSync(GITHUB_EVENT_PATH, "utf8");
		return JSON.parse(raw);
	} catch (error) {
		console.log("Failed to read GitHub event payload:", error);
		return null;
	}
}

const EVENT_PAYLOAD = readGitHubEventPayload();
const PR_NUMBER_FROM_EVENT = EVENT_PAYLOAD?.pull_request?.number
	? String(EVENT_PAYLOAD.pull_request.number)
	: undefined;

const PR_NUMBER = process.env.PR_NUMBER || PR_NUMBER_FROM_EVENT;
const BRANCH_NAME = process.env.BRANCH_NAME || "main";
const REPO_FULL_NAME = process.env.REPO_FULL_NAME!;
const RUN_ID = process.env.RUN_ID!;
const MAIN_BRANCH = process.env.MAIN_BRANCH || "main";

const IS_PR_EVENT = GITHUB_EVENT_NAME === "pull_request";
const IS_PR_CLOSED = IS_PR_EVENT && EVENT_PAYLOAD?.action === "closed";
const IS_CLEANUP = IS_PR_CLOSED;

const MANAGED_POOL_CONFIG: Record<string, any> = (() => {
	try {
		return JSON.parse(process.env.MANAGED_POOL_CONFIG || "{}");
	} catch (e) {
		console.error("Failed to parse MANAGED_POOL_CONFIG:", e);
		return {};
	}
})();

const IS_PR = !!PR_NUMBER;
const IS_MAIN = BRANCH_NAME === MAIN_BRANCH;
const NAMESPACE_NAME = IS_PR ? `pr-${PR_NUMBER}` : "production";
const IMAGE_TAG = GITHUB_SHA.length >= 7 ? GITHUB_SHA.substring(0, 7) : GITHUB_SHA;

function getCloudEndpoint(): string {
	const withoutScheme = RIVET_ENGINE_ENDPOINT.replace(/^https?:\/\//, "");
	return "https://" + withoutScheme.replace(/^api\./, "cloud-api.");
}

function getRegistryEndpoint(): string {
	const withoutScheme = RIVET_ENGINE_ENDPOINT.replace(/^https?:\/\//, "");
	return withoutScheme.replace(/^api\./, "registry.");
}

function getDashboardEndpoint(): string {
	const withoutScheme = RIVET_ENGINE_ENDPOINT.replace(/^https?:\/\//, "");
	return "https://" + withoutScheme.replace(/^api\./, "dashboard.");
}

const COMMENT_MARKER = "<!-- rivet-preview-status -->";

interface RivetData {
	namespace: string;
	engineNamespace: string;
}

const RIVET_DATA_REGEX = /<!--\s*<rivet-data>([\s\S]*?)<\/rivet-data>\s*-->/;

function parseRivetData(body: string): RivetData | null {
	const match = body.match(RIVET_DATA_REGEX);
	if (!match?.[1]) return null;

	try {
		const data = JSON.parse(match[1].trim());
		if (typeof data.namespace === "string" && typeof data.engineNamespace === "string") {
			return {
				namespace: data.namespace,
				engineNamespace: data.engineNamespace,
			};
		}
		return null;
	} catch {
		return null;
	}
}

function buildRivetDataTag(data: RivetData): string {
	return `<!-- <rivet-data>${JSON.stringify(data)}</rivet-data> -->`;
}

// Rivet Cloud API helpers
async function rivetCloudFetch(
	path: string,
	options: RequestInit = {},
	config: { expectJson?: boolean } = {}
): Promise<any> {
	const url = `${getCloudEndpoint()}${path}`;

	const response = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${RIVET_CLOUD_TOKEN}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Rivet Cloud API error: ${response.status} ${text}`);
	}

	if (config.expectJson === false) {
		return { ok: true };
	}

	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// GitHub API helpers
interface ExistingComment {
	id: number;
	body: string;
}

async function findExistingComment(): Promise<ExistingComment | null> {
	if (!IS_PR) return null;

	const response = await fetch(
		`https://api.github.com/repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/comments`,
		{
			headers: {
				Authorization: `token ${GITHUB_TOKEN}`,
				Accept: "application/vnd.github.v3+json",
			},
		}
	);
	const comments = await response.json();
	if (!Array.isArray(comments)) {
		console.log("Comments response:", comments);
		return null;
	}
	const existing = comments.find((c: any) => c.body?.includes(COMMENT_MARKER));
	if (!existing) return null;
	return { id: existing.id, body: existing.body };
}

async function updateComment(commentId: number | null, body: string): Promise<number | null> {
	if (!IS_PR) {
		console.log(body.replace(/\n/g, " ").substring(0, 100));
		return null;
	}

	const fullBody = `${COMMENT_MARKER}\n${body}`;

	if (commentId) {
		await fetch(
			`https://api.github.com/repos/${REPO_FULL_NAME}/issues/comments/${commentId}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `token ${GITHUB_TOKEN}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ body: fullBody }),
			}
		);
		return commentId;
	} else {
		const response = await fetch(
			`https://api.github.com/repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/comments`,
			{
				method: "POST",
				headers: {
					Authorization: `token ${GITHUB_TOKEN}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ body: fullBody }),
			}
		);
		const data = await response.json();
		return data.id;
	}
}

function getRepoProjectName(): string {
	const parts = REPO_FULL_NAME?.split("/") || [];
	return parts[1] || "unknown";
}

function dockerExec(cmd: string): void {
	console.log(`  $ ${cmd.replace(RIVET_CLOUD_TOKEN, "***")}`);
	execSync(cmd, { stdio: "inherit" });
}

async function cleanupFlow(): Promise<void> {
	console.log("=== Rivet Deploy Cleanup ===");
	console.log(`Event: ${GITHUB_EVENT_NAME}${EVENT_PAYLOAD?.action ? ` (${EVENT_PAYLOAD.action})` : ""}`);
	console.log(`Repo: ${REPO_FULL_NAME}`);
	console.log(`PR: ${PR_NUMBER || "unknown"}`);
	console.log("");

	if (!IS_PR) {
		console.log("No PR context found, skipping cleanup.");
		return;
	}

	const existingComment = await findExistingComment();
	let commentId = existingComment?.id ?? null;

	const existingRivetData = existingComment?.body ? parseRivetData(existingComment.body) : null;
	const namespaceName = existingRivetData?.namespace || (PR_NUMBER ? `pr-${PR_NUMBER}` : null);
	const projectName = getRepoProjectName();
	const tableHeader = `| Project | Namespace | Status | Actions |\n|:--------|:----------|:-------|:-------|\n`;
	const intro = "Rivet preview namespace cleanup after PR close.\n\n";

	if (!namespaceName) {
		console.log("No namespace found for cleanup.");
		if (commentId) {
			await updateComment(commentId, intro + tableHeader + `| \`${projectName}\` | - | Not found | - |`);
		}
		return;
	}

	console.log("Inspecting Rivet token...");
	const { project, organization } = await rivetCloudFetch("/tokens/api/inspect");

	console.log("Deleting managed pool...");
	try {
		await rivetCloudFetch(
			`/projects/${project}/namespaces/${namespaceName}/managed-pools/default?org=${encodeURIComponent(organization)}`,
			{ method: "DELETE" },
			{ expectJson: false }
		);
	} catch (error) {
		console.log("Warning: failed to delete managed pool:", error);
	}

	console.log(`Archiving namespace: ${namespaceName}`);
	try {
		await rivetCloudFetch(
			`/projects/${project}/namespaces/${namespaceName}?org=${organization}`,
			{ method: "DELETE" },
			{ expectJson: false }
		);
	} catch (error) {
		console.log(`Warning: failed to archive namespace ${namespaceName}:`, error);
		return;
	}

	console.log("Namespace archived.");
	if (commentId) {
		await updateComment(commentId, intro + tableHeader + `| \`${projectName}\` | \`${namespaceName}\` | Archived | - |`);
	}
}

async function setupFlow(): Promise<void> {
	console.log("=== Rivet Deploy Action ===");
	console.log(`Mode: ${IS_PR ? `PR #${PR_NUMBER}` : `Production (${MAIN_BRANCH} branch)`}`);
	console.log(`Branch: ${BRANCH_NAME}`);
	console.log(`Repo: ${REPO_FULL_NAME}`);
	console.log(`Namespace: ${NAMESPACE_NAME}`);
	console.log(`Dockerfile: ${DOCKERFILE_PATH}`);
	console.log(`Image tag: ${IMAGE_TAG}`);
	console.log(`Rivet Engine Endpoint: ${RIVET_ENGINE_ENDPOINT}`);
	console.log("");

	const runLogsUrl = `https://github.com/${REPO_FULL_NAME}/actions/runs/${RUN_ID}`;
	const existingComment = await findExistingComment();
	let commentId = existingComment?.id ?? null;

	const existingRivetData = existingComment?.body ? parseRivetData(existingComment.body) : null;
	if (existingRivetData) {
		console.log(`Found existing namespace in comment: ${existingRivetData.namespace}`);
	}

	const projectName = getRepoProjectName();

	const intro = IS_PR
		? `This PR has a Rivet namespace. [Learn more](https://rivet.dev/docs)\n\n`
		: `Rivet production namespace. [Learn more](https://rivet.dev/docs)\n\n`;
	const tableHeader = `| Project | Namespace | Status | Actions |\n|:--------|:----------|:-------|:-------|\n`;

	try {
		// Step 1: Inspect token
		console.log("Step 1: Inspecting Rivet token...");
		const { project, organization } = await rivetCloudFetch("/tokens/api/inspect");
		console.log(`  Project: ${project}`);
		console.log(`  Organization: ${organization}`);

		const dashboardUrl = `https://dashboard.rivet.dev/orgs/${organization}/projects/${project}/ns/${NAMESPACE_NAME}?skipOnboarding=1`;

		commentId = await updateComment(
			commentId,
			intro + tableHeader + `| \`${projectName}\` | - | Creating namespace... | - |`
		);

		// Step 2: Create or find namespace
		console.log("");
		console.log("Step 2: Creating/finding namespace...");
		const displayName = IS_PR ? `PR #${PR_NUMBER}` : "Production";

		const namespaceMetadata: Record<string, any> = { skipOnboarding: true };
		if (IS_PR) namespaceMetadata.prNumber = PR_NUMBER;
		if (IS_MAIN) namespaceMetadata.isProduction = true;

		let namespace: any;
		let engineNamespace: string;

		if (existingRivetData) {
			console.log(`  Fetching existing namespace: ${existingRivetData.namespace}`);
			const { namespace: fullNs } = await rivetCloudFetch(
				`/projects/${project}/namespaces/${existingRivetData.namespace}?org=${organization}`
			);
			namespace = fullNs;
			engineNamespace = existingRivetData.engineNamespace;
			console.log(`  Reusing namespace: ${namespace.name}`);
		} else {
			console.log(`  Creating new namespace: ${NAMESPACE_NAME}`);
			const result = await rivetCloudFetch(`/projects/${project}/namespaces?org=${organization}`, {
				method: "POST",
				body: JSON.stringify({
					name: NAMESPACE_NAME,
					displayName,
					metadata: namespaceMetadata,
				}),
			});
			namespace = result.namespace;
			engineNamespace = namespace.access?.engineNamespaceName || namespace.name;
			console.log(`  Created namespace: ${namespace.name}`);
		}

		const rivetDataTag = buildRivetDataTag({ namespace: namespace.name, engineNamespace });
		const registry = getRegistryEndpoint();
		const imageName = projectName;
		const poolName = "default";
		const imageRef = `${registry}/${imageName}:${IMAGE_TAG}`;

		// Step 3: Upsert managed pool with dummy image (required before first push)
		console.log("");
		console.log("Step 3: Upserting managed pool (dummy image)...");
		await rivetCloudFetch(
			`/projects/${project}/namespaces/${namespace.name}/managed-pools/${poolName}?org=${encodeURIComponent(organization)}`,
			{
				method: "PUT",
				body: JSON.stringify({
					displayName,
					minCount: 0,
					maxCount: 10,
					...MANAGED_POOL_CONFIG,
					image: { repository: "init", tag: "0.0.0" },
				}),
			}
		);

		// Step 4: Docker login
		console.log("");
		console.log("Step 4: Docker login to Rivet registry...");
		console.log(`  Registry: ${registry}`);
		commentId = await updateComment(
			commentId,
			rivetDataTag + "\n" + intro + tableHeader + `| \`${projectName}\` | \`${namespace.name}\` | Building image... | <a href="${dashboardUrl}" target="_blank">Dashboard</a> |`
		);
		dockerExec(`docker login ${registry} --username rivet --password ${RIVET_CLOUD_TOKEN}`);

		// Step 5: Docker build
		console.log("");
		console.log("Step 5: Building Docker image...");
		console.log(`  Image: ${imageRef}`);
		dockerExec(`docker build ${DOCKER_BUILD_PATH} -f ${DOCKERFILE_PATH} -t ${imageRef}`);

		// Step 6: Docker push
		console.log("");
		console.log("Step 6: Pushing image to registry...");
		commentId = await updateComment(
			commentId,
			rivetDataTag + "\n" + intro + tableHeader + `| \`${projectName}\` | \`${namespace.name}\` | Pushing image... | <a href="${dashboardUrl}" target="_blank">Dashboard</a> |`
		);
		dockerExec(`docker push ${imageRef}`);

		// Step 7: Upsert managed pool
		console.log("");
		console.log("Step 7: Upserting managed pool...");
		console.log(`  Pool: ${poolName}`);
		commentId = await updateComment(
			commentId,
			rivetDataTag + "\n" + intro + tableHeader + `| \`${projectName}\` | \`${namespace.name}\` | Upserting pool... | <a href="${dashboardUrl}" target="_blank">Dashboard</a> |`
		);

		const poolBody = {
			displayName,
			minCount: 0,
			maxCount: 10,
			...MANAGED_POOL_CONFIG,
			// image is always set from the docker push and cannot be overridden
			image: {
				repository: imageName,
				tag: IMAGE_TAG,
			},
		};

		await rivetCloudFetch(
			`/projects/${project}/namespaces/${namespace.name}/managed-pools/${poolName}?org=${encodeURIComponent(organization)}`,
			{
				method: "PUT",
				body: JSON.stringify(poolBody),
			}
		);

		// Step 8: Done
		console.log("");
		console.log("=== Success! ===");
		console.log(`  Namespace: ${namespace.name}`);
		console.log(`  Image: ${imageRef}`);
		console.log(`  Pool: ${poolName}`);
		console.log(`  Dashboard: ${dashboardUrl}`);
		await updateComment(
			commentId,
			rivetDataTag + "\n" + intro + tableHeader + `| \`${projectName}\` | \`${namespace.name}\` | Ready | <a href="${dashboardUrl}" target="_blank">Dashboard</a> |`
		);
	} catch (error: any) {
		console.error("Error:", error);

		await updateComment(
			commentId,
			intro + tableHeader + `| \`${projectName}\` | - | Failed | [Logs](${runLogsUrl}) |`
		);

		process.exit(1);
	}
}

async function main() {
	if (IS_CLEANUP) {
		await cleanupFlow();
		return;
	}

	await setupFlow();
}

main();
