// TypeScript source of the action. The compiled output is committed in dist/index.js.
// This action creates/updates a release PR and exposes outputs as per docs/design.md.

import * as core from "@actions/core";
import { getOctokit, context as ghContext } from "@actions/github";
import {
	PullRequestEvent as WebhookPullRequestEvent,
	PushEvent,
} from "@octokit/webhooks-definitions/schema";
import * as semver from "semver";

type BumpLevel = "major" | "minor" | "patch" | "unknown";

interface Config {
	owner: string;
	repo: string;
	baseBranch: string;
	releaseBranchPrefix: string;
	labelMajor: string;
	labelMinor: string;
	labelPatch: string;
	tagPrefix: string;
	releaseCfgPath?: string;
	skipReleaseNotes: boolean;
}

interface ReleaseInfo {
	currentTag: semver.SemVer | null;
	nextTag: string;
	bumpLevel: BumpLevel;
	notes: string;
}

// Wrapper function to set output and log it
function setOutputWithLog(name: string, value: string): void {
	core.info(`Setting output: ${name}=${value}`);
	core.setOutput(name, value);
}

function getConfig(): Config {
	const repoFull = process.env.GITHUB_REPOSITORY || "";
	const [owner, repo] = repoFull.split("/");
	if (!owner || !repo)
		throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);

	return {
		owner,
		repo,
		baseBranch: core.getInput("base-branch") || "main",
		releaseBranchPrefix: core.getInput("release-branch") || "release-pr",
		labelMajor: core.getInput("label-major") || "bump:major",
		labelMinor: core.getInput("label-minor") || "bump:minor",
		labelPatch: core.getInput("label-patch") || "bump:patch",
		tagPrefix: core.getInput("tag-prefix") || "v",
		releaseCfgPath: core.getInput("configuration_file_path") || undefined,
		skipReleaseNotes: core.getInput("skip-release-notes") === "true",
	};
}

async function run(): Promise<void> {
	try {
		core.info("Starting create-release-pr action");
		const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
		if (!token) throw new Error("Missing github-token");

		const config = getConfig();
		const eventName = ghContext.eventName;
		core.debug(`Event name: ${eventName}`);
		core.debug(
			`Configuration: baseBranch=${config.baseBranch}, releaseBranchPrefix=${config.releaseBranchPrefix}, tagPrefix=${config.tagPrefix}`,
		);

		const octokit = getOctokit(token);

		if (eventName === "pull_request") {
			await handlePullRequestEvent(octokit, config);
			return;
		}

		if (eventName === "push") {
			await handlePushEvent(octokit, config);
			return;
		}

		core.info(`Event '${eventName}' does not require action`);
		setOutputWithLog("state", "noop");
		return;
	} catch (err: unknown) {
		core.error(
			`Action failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		core.setFailed(
			err instanceof Error ? err.stack || err.message : String(err),
		);
		process.exit(1);
	}
}

async function latestTag(
	octokit: ReturnType<typeof getOctokit>,
	owner: string,
	repo: string,
): Promise<semver.SemVer | null> {
	core.debug(`Fetching latest release`);

	try {
		const { data: latestRelease } = await octokit.rest.repos.getLatestRelease({
			owner,
			repo,
		});

		if (latestRelease.tag_name) {
			const parsed = semver.parse(latestRelease.tag_name);
			if (parsed) {
				core.debug(`Found latest release: ${latestRelease.tag_name}`);
				return parsed;
			}
			core.debug(
				`Latest release ${latestRelease.tag_name} is not valid semver`,
			);
		}
	} catch (err) {
		core.debug(
			`No releases found or error getting latest release: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return null;
}

function detectBump(
	labels: Array<string | { name: string }>,
	cfg: { labelMajor: string; labelMinor: string; labelPatch: string },
): BumpLevel {
	const names = new Set(
		(labels || []).map((l) => (typeof l === "string" ? l : l.name)),
	);
	if (names.has(cfg.labelMajor)) return "major";
	if (names.has(cfg.labelMinor)) return "minor";
	if (names.has(cfg.labelPatch)) return "patch";
	return "unknown";
}

function detectBumpFromConfig(
	labels: Array<string | { name: string }>,
	config: Config,
): BumpLevel {
	return detectBump(labels, {
		labelMajor: config.labelMajor,
		labelMinor: config.labelMinor,
		labelPatch: config.labelPatch,
	});
}

function calcNext(
	prefix: string,
	currentTag: semver.SemVer | null,
	bumpLevel: BumpLevel,
): string {
	const cur = currentTag || semver.parse("0.0.0");
	if (!cur) {
		throw new Error(`Failed to parse version`);
	}

	if (bumpLevel === "unknown") {
		return "";
	}

	const newVersion = semver.inc(cur, bumpLevel as "major" | "minor" | "patch");
	if (!newVersion) {
		throw new Error(`Failed to increment version`);
	}

	return `${prefix}${newVersion}`;
}

function getReleaseBranchName(
	prefix: string,
	currentTag: string | null,
): string {
	if (currentTag) {
		return `${prefix}-from-${currentTag}`;
	}
	return `${prefix}-from-initial`;
}

async function generateNotes(
	octokit: ReturnType<typeof getOctokit>,
	owner: string,
	repo: string,
	{
		tagName,
		target,
		previousTagName,
		configuration_file_path,
	}: {
		tagName: string;
		target: string;
		previousTagName?: string;
		configuration_file_path?: string;
	},
): Promise<string> {
	try {
		const res = await octokit.rest.repos.generateReleaseNotes({
			owner,
			repo,
			tag_name: tagName,
			target_commitish: target,
			previous_tag_name: previousTagName,
			configuration_file_path,
		});
		return res.data.body || "";
	} catch (err) {
		core.warning(
			`Failed to generate release notes: ${err instanceof Error ? err.message : String(err)}`,
		);
		return "";
	}
}

async function findOpenReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	{
		owner,
		repo,
		baseBranch,
		releaseBranch,
	}: { owner: string; repo: string; baseBranch: string; releaseBranch: string },
) {
	const { data: prs } = await octokit.rest.pulls.list({
		owner,
		repo,
		state: "open",
		base: baseBranch,
		head: `${owner}:${releaseBranch}`,
	});
	return Array.isArray(prs) && prs.length ? prs[0] : null;
}

async function ensureReleaseBranch(
	octokit: ReturnType<typeof getOctokit>,
	owner: string,
	repo: string,
	{ baseBranch, releaseBranch }: { baseBranch: string; releaseBranch: string },
) {
	core.debug(`Ensuring release branch: ${releaseBranch}`);
	try {
		const { data: ref } = await octokit.rest.git.getRef({
			owner,
			repo,
			ref: `heads/${releaseBranch}`,
		});
		if (ref && ref.object?.sha) {
			core.debug(`Release branch exists at SHA: ${ref.object.sha}`);
			return; // exists
		}
	} catch {
		core.debug("Release branch does not exist, creating...");
	}
	const { data: baseRef } = await octokit.rest.git.getRef({
		owner,
		repo,
		ref: `heads/${baseBranch}`,
	});
	const baseSha = baseRef.object.sha;
	const { data: baseCommit } = await octokit.rest.git.getCommit({
		owner,
		repo,
		commit_sha: baseSha,
	});
	const treeSha = baseCommit.tree.sha;
	const { data: newCommit } = await octokit.rest.git.createCommit({
		owner,
		repo,
		message: "chore(release): prepare release PR",
		tree: treeSha,
		parents: [baseSha],
	});
	const newSha = newCommit.sha;
	await octokit.rest.git.createRef({
		owner,
		repo,
		ref: `refs/heads/${releaseBranch}`,
		sha: newSha,
	});
	core.info(`Created release branch ${releaseBranch} at SHA: ${newSha}`);
}

async function setCommitStatusForBumpLabel(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	sha: string,
	bumpLevel: BumpLevel,
): Promise<void> {
	const hasValidBumpLabel = bumpLevel !== "unknown";
	const state = hasValidBumpLabel ? "success" : "pending";
	const description = hasValidBumpLabel
		? `Bump level: ${bumpLevel}`
		: `Missing bump label. Add ${config.labelMajor}, ${config.labelMinor}, or ${config.labelPatch}`;

	try {
		await octokit.rest.repos.createCommitStatus({
			owner: config.owner,
			repo: config.repo,
			sha,
			state: state as "error" | "failure" | "pending" | "success",
			description,
			context: "create-release-pr/bump-label",
		});
		core.info(`Status check set: ${state} - ${description}`);
	} catch (err) {
		core.warning(
			`Failed to set commit status: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function ensureAndAddLabel(
	octokit: ReturnType<typeof getOctokit>,
	owner: string,
	repo: string,
	prNumber: number,
	labelName: string,
): Promise<void> {
	try {
		// First, try to create the label if it doesn't exist
		try {
			await octokit.rest.issues.getLabel({
				owner,
				repo,
				name: labelName,
			});
			core.debug(`Label "${labelName}" already exists`);
		} catch {
			// Label doesn't exist, create it
			core.info(`Creating "${labelName}" label`);
			await octokit.rest.issues.createLabel({
				owner,
				repo,
				name: labelName,
				color: "0E8A16", // Green color
				description: "Pull request for release",
			});
			core.info(`Created "${labelName}" label`);
		}

		// Now add the label to the PR
		await octokit.rest.issues.addLabels({
			owner,
			repo,
			issue_number: prNumber,
			labels: [labelName],
		});
		core.info(`Added "${labelName}" label to PR #${prNumber}`);
	} catch (labelErr) {
		core.warning(
			`Failed to add "${labelName}" label: ${labelErr instanceof Error ? labelErr.message : String(labelErr)}`,
		);
	}
}

function buildPRText({
	owner,
	repo,
	baseBranch,
	releaseBranch,
	labelMajor,
	labelMinor,
	labelPatch,
	currentTag,
	nextTag,
	notes,
	skipReleaseNotes,
}: {
	owner: string;
	repo: string;
	baseBranch: string;
	releaseBranch: string;
	labelMajor: string;
	labelMinor: string;
	labelPatch: string;
	currentTag: string | null;
	nextTag: string;
	notes: string;
	skipReleaseNotes: boolean;
}) {
	const known = !!nextTag;
	const title = known ? `Release for ${nextTag}` : "Release for new version";
	const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
	const parts: string[] = [];

	parts.push(
		`You can directly edit the [${releaseBranch}](${serverUrl}/${owner}/${repo}/tree/${releaseBranch}) branch to prepare for the release.`,
	);
	parts.push("");
	parts.push("<details>");
	parts.push("<summary>How to specify the next version</summary>");
	parts.push("");
	parts.push(
		"Add one of the following labels to this PR to specify the version bump:",
	);
	parts.push(
		`- \`${labelMajor}\` - for major version bump (e.g., 1.0.0 → 2.0.0)`,
	);
	parts.push(
		`- \`${labelMinor}\` - for minor version bump (e.g., 1.0.0 → 1.1.0)`,
	);
	parts.push(
		`- \`${labelPatch}\` - for patch version bump (e.g., 1.0.0 → 1.0.1)`,
	);
	parts.push("");
	parts.push("</details>");
	parts.push("");
	if (!skipReleaseNotes) {
		if (notes) {
			if (nextTag) {
				parts.push(`# Release ${nextTag}`);
				parts.push("");
			}
			// Replace the Full Changelog link to use baseBranch instead of nextTag
			let modifiedNotes = notes;
			if (currentTag && nextTag) {
				// Simple regex to replace ${currentTag}...${nextTag} with ${currentTag}...${baseBranch}
				const fullChangelogPattern = new RegExp(
					`(\\*\\*Full Changelog\\*\\*: .*\\/compare\\/)${currentTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\.\\.${nextTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
					"g",
				);
				modifiedNotes = notes.replace(
					fullChangelogPattern,
					`$1${currentTag}...${baseBranch}`,
				);
			}
			parts.push(modifiedNotes);
		} else {
			parts.push("_Release notes will be generated here_");
		}
	}

	// Add workflow update metadata at the end, right-aligned
	const runId = process.env.GITHUB_RUN_ID;
	const updateTime = new Date().toISOString();

	if (runId) {
		const workflowUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`;
		parts.push("");
		parts.push(
			`<div align="right"><sub>Last updated: <a href="${workflowUrl}">${updateTime}</a> by <a href='${serverUrl}/actionutils/create-release-pr'>create-release-pr</a></sub></div>`,
		);
	}

	return { title, body: parts.join("\n") };
}

async function handlePullRequestEvent(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
): Promise<void> {
	core.info("Processing pull_request event");
	const payload = ghContext.payload as WebhookPullRequestEvent;
	const action = payload.action;
	core.debug(`PR action: ${action}`);

	// Handle status check for release PR
	if (
		action === "opened" ||
		action === "synchronize" ||
		action === "reopened" ||
		action === "labeled" ||
		action === "unlabeled"
	) {
		// Continue processing
	} else {
		core.info(`Action '${action}' is not relevant - skipping`);
		setOutputWithLog("state", "noop");
		return;
	}

	const pr = payload.pull_request;
	if (!pr) {
		setOutputWithLog("state", "noop");
		return;
	}

	// Get current tag to determine the release branch name
	const currentTag = await latestTag(octokit, config.owner, config.repo);
	const releaseBranch = getReleaseBranchName(
		config.releaseBranchPrefix,
		currentTag?.raw || null,
	);

	// Check if this is the release PR itself
	if (pr.head.ref === releaseBranch) {
		if (action === "labeled" || action === "unlabeled") {
			core.info("Label change on release PR - updating");
			await updateReleasePR(octokit, config, pr, releaseBranch, currentTag);
		} else {
			// For opened/synchronize/reopened, update PR (which also sets status check)
			core.info("Release PR opened/updated - updating");
			await updateReleasePR(octokit, config, pr, releaseBranch, currentTag);
		}
		return;
	}

	// For closed PRs, we need to update the release PR to regenerate release notes
	if (pr.state === "closed" && pr.merged) {
		core.info("Label change on closed/merged PR - updating release PR notes");

		// Find the open release PR to update
		const releasePR = await findOpenReleasePR(octokit, {
			owner: config.owner,
			repo: config.repo,
			baseBranch: config.baseBranch,
			releaseBranch: releaseBranch,
		});

		if (releasePR && releasePR.number) {
			core.info(
				`Found release PR #${releasePR.number} - updating with new release notes`,
			);
			await updateReleasePR(
				octokit,
				config,
				releasePR as WebhookPullRequestEvent["pull_request"],
				releaseBranch,
				currentTag,
			);
		} else {
			core.info("No open release PR found - skipping");
			setOutputWithLog("state", "noop");
		}
		return;
	}

	core.info("Label change on non-release, non-merged PR - skipping");
	setOutputWithLog("state", "noop");
}

async function updateReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	pr: {
		number: number;
		html_url: string;
		head: { sha: string };
		labels?: Array<string | { name: string }>;
	},
	releaseBranch: string,
	currentTag: semver.SemVer | null,
): Promise<void> {
	core.info(`Processing release PR #${pr.number}`);

	const releaseInfo = await getReleaseInfo(
		octokit,
		config,
		pr.labels || [],
		currentTag,
	);

	// Always set commit status
	await setCommitStatusForBumpLabel(
		octokit,
		config,
		pr.head.sha,
		releaseInfo.bumpLevel,
	);

	const { title, body } = buildPRText({
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: releaseBranch,
		labelMajor: config.labelMajor,
		labelMinor: config.labelMinor,
		labelPatch: config.labelPatch,
		currentTag: releaseInfo.currentTag?.raw || null,
		nextTag: releaseInfo.nextTag,
		notes: releaseInfo.notes,
		skipReleaseNotes: config.skipReleaseNotes,
	});

	core.info(`Updating PR #${pr.number} with new title and body`);
	await octokit.rest.pulls.update({
		owner: config.owner,
		repo: config.repo,
		pull_number: pr.number,
		title,
		body,
	});

	core.info("PR updated successfully");
	setReleaseOutputs("release_pr_open", {
		prNumber: String(pr.number),
		prUrl: pr.html_url,
		prBranch: releaseBranch,
		currentTag: releaseInfo.currentTag?.raw || null,
		nextTag: releaseInfo.nextTag,
		bumpLevel: releaseInfo.bumpLevel,
		notes: releaseInfo.notes,
	});
}

async function handlePushEvent(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
): Promise<void> {
	core.info("Processing push event");
	const pushPayload = ghContext.payload as PushEvent;
	const headSha = pushPayload.after;
	core.debug(`Head SHA: ${headSha}`);

	// Get current tag to determine the release branch name
	const currentTag = await latestTag(octokit, config.owner, config.repo);
	core.info(`Current tag: ${currentTag?.raw || "(none)"}`);
	const releaseBranch = getReleaseBranchName(
		config.releaseBranchPrefix,
		currentTag?.raw || null,
	);

	// Check if this push is from a merged release PR
	const releasePR = await findMergedReleasePR(
		octokit,
		config,
		headSha,
		releaseBranch,
	);
	if (releasePR) {
		await handleMergedReleasePR(octokit, config, releasePR, currentTag);
		return;
	}

	// Check for existing open release PR
	core.info("Checking for existing release PR");

	const existing = await findOpenReleasePR(octokit, {
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: releaseBranch,
	}).catch(() => null);

	if (existing && existing.number) {
		await updateReleasePR(octokit, config, existing, releaseBranch, currentTag);
	} else {
		await createNewReleasePR(octokit, config, currentTag, releaseBranch);
	}
}

async function findMergedReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	headSha: string,
	releaseBranch: string,
): Promise<WebhookPullRequestEvent["pull_request"] | undefined> {
	try {
		const { data } =
			await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
				owner: config.owner,
				repo: config.repo,
				commit_sha: headSha,
			});
		return (data || []).find((p) => p.head?.ref === releaseBranch) as
			| WebhookPullRequestEvent["pull_request"]
			| undefined;
	} catch {
		return undefined;
	}
}

async function handleMergedReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	relPR: WebhookPullRequestEvent["pull_request"],
	currentTag: semver.SemVer | null,
): Promise<void> {
	core.info(`Found merged release PR: #${relPR.number}`);
	core.info(`Current tag: ${currentTag?.raw || "(none)"}`);

	const bumpLevel = detectBumpFromConfig(relPR.labels || [], config);
	core.info(`Detected bump level: ${bumpLevel}`);

	// Error if no bump level is specified
	if (bumpLevel === "unknown") {
		throw new Error(
			`Release PR #${relPR.number} was merged without a bump label. ` +
				`Please add one of the following labels: ${config.labelMajor}, ${config.labelMinor}, or ${config.labelPatch}`,
		);
	}

	const nextTag = calcNext(config.tagPrefix, currentTag, bumpLevel);
	core.info(`Release required for: ${nextTag}`);

	// Generate release notes for the merged PR
	const notes = await generateNotes(octokit, config.owner, config.repo, {
		tagName: nextTag,
		target: config.baseBranch,
		previousTagName: currentTag?.raw || undefined,
		configuration_file_path: config.releaseCfgPath,
	});

	setReleaseOutputs("release_required", {
		prNumber: String(relPR.number),
		prUrl: relPR.html_url || "",
		prBranch: "",
		currentTag: currentTag?.raw || null,
		nextTag,
		bumpLevel,
		notes,
	});
}

async function createNewReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	currentTag: semver.SemVer | null,
	releaseBranch: string,
): Promise<void> {
	core.info("No existing release PR found - creating new one");

	await ensureReleaseBranch(octokit, config.owner, config.repo, {
		baseBranch: config.baseBranch,
		releaseBranch: releaseBranch,
	});

	const bumpLevel: BumpLevel = "unknown";
	const nextTag = "";
	core.info("Release branch ensured, creating PR with unknown bump level");

	const notes = await generateNotes(octokit, config.owner, config.repo, {
		tagName: config.baseBranch,
		target: config.baseBranch,
		previousTagName: currentTag?.raw || undefined,
		configuration_file_path: config.releaseCfgPath,
	});

	const { title, body } = buildPRText({
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: releaseBranch,
		labelMajor: config.labelMajor,
		labelMinor: config.labelMinor,
		labelPatch: config.labelPatch,
		currentTag: currentTag?.raw || null,
		nextTag,
		notes,
		skipReleaseNotes: config.skipReleaseNotes,
	});

	core.info(
		`Creating release PR from ${releaseBranch} to ${config.baseBranch}`,
	);
	const { data: created } = await octokit.rest.pulls.create({
		owner: config.owner,
		repo: config.repo,
		title,
		head: releaseBranch,
		base: config.baseBranch,
		body,
		draft: true,
	});

	core.info(`Created release PR #${created.number}`);
	await ensureAndAddLabel(
		octokit,
		config.owner,
		config.repo,
		created.number,
		"release-pr",
	);

	setReleaseOutputs("release_pr_open", {
		prNumber: String(created.number),
		prUrl: created.html_url,
		prBranch: releaseBranch,
		currentTag: currentTag?.raw || null,
		nextTag,
		bumpLevel,
		notes,
	});
}

async function getReleaseInfo(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	labels: Array<string | { name: string }>,
	currentTag: semver.SemVer | null,
): Promise<ReleaseInfo> {
	core.info(`Current tag: ${currentTag?.raw || "(none)"}`);

	const bumpLevel = detectBumpFromConfig(labels, config);
	core.info(`Detected bump level: ${bumpLevel}`);

	const nextTag =
		bumpLevel === "unknown"
			? ""
			: calcNext(config.tagPrefix, currentTag, bumpLevel);
	if (nextTag) core.info(`Next tag will be: ${nextTag}`);

	const notes = await generateNotes(octokit, config.owner, config.repo, {
		tagName: nextTag || config.baseBranch,
		target: config.baseBranch,
		previousTagName: currentTag?.raw || undefined,
		configuration_file_path: config.releaseCfgPath,
	});

	return { currentTag, nextTag, bumpLevel, notes };
}

function setReleaseOutputs(
	state: string,
	info: {
		prNumber: string;
		prUrl: string;
		prBranch: string;
		currentTag: string | null;
		nextTag: string;
		bumpLevel: BumpLevel;
		notes: string;
	},
): void {
	setOutputWithLog("state", state);
	setOutputWithLog("pr_number", info.prNumber);
	setOutputWithLog("pr_url", info.prUrl);
	setOutputWithLog("pr_branch", info.prBranch);
	setOutputWithLog("current_tag", info.currentTag || "");
	setOutputWithLog("next_tag", info.nextTag || "");
	setOutputWithLog("bump_level", info.bumpLevel);
	setOutputWithLog("release_notes", info.notes);
}

void run();
