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
	releaseBranch: string;
	labelMajor: string;
	labelMinor: string;
	labelPatch: string;
	tagPrefix: string;
	releaseCfgPath?: string;
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
		releaseBranch: core.getInput("release-branch") || "release/pr",
		labelMajor: core.getInput("label-major") || "bump:major",
		labelMinor: core.getInput("label-minor") || "bump:minor",
		labelPatch: core.getInput("label-patch") || "bump:patch",
		tagPrefix: core.getInput("tag-prefix") || "v",
		releaseCfgPath: core.getInput("configuration_file_path") || undefined,
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
			`Configuration: baseBranch=${config.baseBranch}, releaseBranch=${config.releaseBranch}, tagPrefix=${config.tagPrefix}`,
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
	const res = await octokit.rest.repos.generateReleaseNotes({
		owner,
		repo,
		tag_name: tagName,
		target_commitish: target,
		previous_tag_name: previousTagName,
		configuration_file_path,
	});
	return res.data.body || "";
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
	currentTag,
	nextTag,
	notes,
}: {
	owner: string;
	repo: string;
	baseBranch: string;
	releaseBranch: string;
	currentTag: string | null;
	nextTag: string;
	notes: string;
}) {
	const known = !!nextTag;
	const title = known ? `Release for ${nextTag}` : "Release for new version";
	const parts: string[] = [];
	// Build the release info table
	parts.push("<details><summary>Release Information</summary>");
	parts.push("");
	parts.push("| | |");
	parts.push("|---|---|");

	// Current tag with link to release page
	if (currentTag) {
		parts.push(
			`| **Current Release** | [${currentTag}](https://github.com/${owner}/${repo}/releases/tag/${currentTag}) |`,
		);
	} else {
		parts.push("| **Current Release** | (none) |");
	}

	const nextTagOrTBD =
		nextTag || "TBD - Add label: `bump:major`, `bump:minor`, or `bump:patch`";

	// Next tag
	parts.push(`| **Next Release** | ${nextTagOrTBD} |`);

	// Full changelog link
	if (currentTag) {
		parts.push(
			`| **Changes** | [View Diff](https://github.com/${owner}/${repo}/compare/${currentTag}...${baseBranch}) |`,
		);
	}
	parts.push("");
	parts.push("</details>");

	parts.push("");
	parts.push("---");
	parts.push("");
	parts.push("### ↓ Release Notes Preview ↓");
	parts.push("");
	if (notes) {
		parts.push(`# Release ${nextTagOrTBD}`);
		parts.push("");
		// Replace the Full Changelog link with a working View Diff link
		let modifiedNotes = notes;
		if (currentTag && nextTag) {
			const fullChangelogPattern = /\*\*Full Changelog\*\*: https:\/\/github\.com\/[^\/]+\/[^\/]+\/compare\/[^\.]+\.\.\.[^\s]+/g;
			const viewDiffLink = `**Full Changelog**: https://github.com/${owner}/${repo}/compare/${currentTag}...${baseBranch}`;
			modifiedNotes = notes.replace(fullChangelogPattern, viewDiffLink);
		}
		parts.push(modifiedNotes);
	} else {
		parts.push("_Release notes will be generated here_");
	}
	parts.push("");
	parts.push("---");

	// Add workflow update metadata at the end, right-aligned
	const runId = process.env.GITHUB_RUN_ID;
	const updateTime = new Date().toISOString();

	if (runId) {
		const workflowUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
		parts.push("");
		parts.push(
			`<div align="right"><sub>Last updated: <a href="${workflowUrl}">${updateTime}</a> by <a href='https://github.com/actionutils/create-release-pr'>create-release-pr</a></sub></div>`,
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

	if (action !== "labeled" && action !== "unlabeled") {
		core.info("Action is not labeled/unlabeled - skipping");
		setOutputWithLog("state", "noop");
		return;
	}

	const pr = payload.pull_request;
	if (!pr) {
		setOutputWithLog("state", "noop");
		return;
	}

	// Check if this is the release PR itself
	if (pr.head.ref === config.releaseBranch) {
		core.info("Label change on release PR - updating");
		await updateReleasePR(octokit, config, pr);
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
			releaseBranch: config.releaseBranch,
		});

		if (releasePR && releasePR.number) {
			core.info(
				`Found release PR #${releasePR.number} - updating with new release notes`,
			);
			await updateReleasePR(
				octokit,
				config,
				releasePR as WebhookPullRequestEvent["pull_request"],
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
	pr: WebhookPullRequestEvent["pull_request"],
): Promise<void> {
	core.info(`Processing release PR #${pr.number}`);

	const releaseInfo = await getReleaseInfo(octokit, config, pr.labels || []);
	const { title, body } = buildPRText({
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: config.releaseBranch,
		currentTag: releaseInfo.currentTag?.raw || null,
		nextTag: releaseInfo.nextTag,
		notes: releaseInfo.notes,
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
	setReleaseOutputs("pr_changed", {
		prNumber: String(pr.number),
		prUrl: pr.html_url,
		prBranch: config.releaseBranch,
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

	// Check if this push is from a merged release PR
	const releasePR = await findMergedReleasePR(octokit, config, headSha);
	if (releasePR) {
		await handleMergedReleasePR(octokit, config, releasePR);
		return;
	}

	// Check for existing open release PR
	core.info("Checking for existing release PR");
	const currentTag = await latestTag(octokit, config.owner, config.repo);
	core.info(`Current tag: ${currentTag?.raw || "(none)"}`);

	const existing = await findOpenReleasePR(octokit, {
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: config.releaseBranch,
	}).catch(() => null);

	if (existing && existing.number) {
		await updateExistingReleasePR(octokit, config, existing);
	} else {
		await createNewReleasePR(octokit, config, currentTag);
	}
}

async function findMergedReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	headSha: string,
): Promise<WebhookPullRequestEvent["pull_request"] | undefined> {
	try {
		const { data } =
			await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
				owner: config.owner,
				repo: config.repo,
				commit_sha: headSha,
			});
		return (data || []).find((p) => p.head?.ref === config.releaseBranch) as
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
): Promise<void> {
	core.info(`Found merged release PR: #${relPR.number}`);

	const currentTag = await latestTag(octokit, config.owner, config.repo);
	core.info(`Current tag: ${currentTag?.raw || "(none)"}`);

	const bumpLevel = detectBump(relPR.labels || [], {
		labelMajor: config.labelMajor,
		labelMinor: config.labelMinor,
		labelPatch: config.labelPatch,
	});
	core.info(`Detected bump level: ${bumpLevel}`);

	const nextTag =
		bumpLevel === "unknown"
			? ""
			: calcNext(config.tagPrefix, currentTag, bumpLevel);
	if (nextTag) core.info(`Release required for: ${nextTag}`);

	setReleaseOutputs("release_required", {
		prNumber: "",
		prUrl: "",
		prBranch: "",
		currentTag: currentTag?.raw || null,
		nextTag,
		bumpLevel,
		notes: "",
	});
}

async function updateExistingReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	existing: any,
): Promise<void> {
	core.info(`Found existing release PR #${existing.number} - updating`);

	const releaseInfo = await getReleaseInfo(
		octokit,
		config,
		existing.labels || [],
	);

	const { title, body } = buildPRText({
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: config.releaseBranch,
		currentTag: releaseInfo.currentTag?.raw || null,
		nextTag: releaseInfo.nextTag,
		notes: releaseInfo.notes,
	});

	core.info(`Updating PR #${existing.number}`);
	const { data: updated } = await octokit.rest.pulls.update({
		owner: config.owner,
		repo: config.repo,
		pull_number: existing.number,
		title,
		body,
	});

	core.info("PR updated successfully");
	setReleaseOutputs("pr_changed", {
		prNumber: String(updated.number),
		prUrl: updated.html_url,
		prBranch: config.releaseBranch,
		currentTag: releaseInfo.currentTag?.raw || null,
		nextTag: releaseInfo.nextTag,
		bumpLevel: releaseInfo.bumpLevel,
		notes: releaseInfo.notes,
	});
}

async function createNewReleasePR(
	octokit: ReturnType<typeof getOctokit>,
	config: Config,
	currentTag: semver.SemVer | null,
): Promise<void> {
	core.info("No existing release PR found - creating new one");

	await ensureReleaseBranch(octokit, config.owner, config.repo, {
		baseBranch: config.baseBranch,
		releaseBranch: config.releaseBranch,
	});

	const bumpLevel: BumpLevel = "unknown";
	const nextTag = "";
	core.info("Release branch ensured, creating PR with unknown bump level");

	const notes = await generateNotes(octokit, config.owner, config.repo, {
		tagName: `${config.tagPrefix}next`,
		target: config.baseBranch,
		previousTagName: currentTag?.raw || undefined,
		configuration_file_path: config.releaseCfgPath,
	}).catch(() => "");

	const { title, body } = buildPRText({
		owner: config.owner,
		repo: config.repo,
		baseBranch: config.baseBranch,
		releaseBranch: config.releaseBranch,
		currentTag: currentTag?.raw || null,
		nextTag,
		notes,
	});

	core.info(
		`Creating release PR from ${config.releaseBranch} to ${config.baseBranch}`,
	);
	const { data: created } = await octokit.rest.pulls.create({
		owner: config.owner,
		repo: config.repo,
		title,
		head: config.releaseBranch,
		base: config.baseBranch,
		body,
		draft: false,
	});

	core.info(`Created release PR #${created.number}`);
	await ensureAndAddLabel(
		octokit,
		config.owner,
		config.repo,
		created.number,
		"release-pr",
	);

	setReleaseOutputs("pr_changed", {
		prNumber: String(created.number),
		prUrl: created.html_url,
		prBranch: config.releaseBranch,
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
): Promise<ReleaseInfo> {
	const currentTag = await latestTag(octokit, config.owner, config.repo);
	core.info(`Current tag: ${currentTag?.raw || "(none)"}`);

	const bumpLevel = detectBump(labels, {
		labelMajor: config.labelMajor,
		labelMinor: config.labelMinor,
		labelPatch: config.labelPatch,
	});
	core.info(`Detected bump level: ${bumpLevel}`);

	const nextTag =
		bumpLevel === "unknown"
			? ""
			: calcNext(config.tagPrefix, currentTag, bumpLevel);
	if (nextTag) core.info(`Next tag will be: ${nextTag}`);

	const notes = await generateNotes(octokit, config.owner, config.repo, {
		tagName: nextTag || `${config.tagPrefix}next`,
		target: config.baseBranch,
		previousTagName: currentTag?.raw || undefined,
		configuration_file_path: config.releaseCfgPath,
	}).catch(() => "");

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
