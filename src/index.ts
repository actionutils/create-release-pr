// TypeScript source of the action. The compiled output is committed in dist/index.js.
// This action creates/updates a release PR and exposes outputs as per docs/design.md.

import * as core from "@actions/core";
import { getOctokit, context as ghContext } from "@actions/github";
import {
	PullRequestEvent as WebhookPullRequestEvent,
	PushEvent,
} from "@octokit/webhooks-definitions/schema";

type BumpLevel = "major" | "minor" | "patch" | "unknown";

// Wrapper function to set output and log it
function setOutputWithLog(name: string, value: string): void {
	core.info(`Setting output: ${name}=${value}`);
	core.setOutput(name, value);
}

async function run(): Promise<void> {
	try {
		core.info("Starting create-release-pr action");
		const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
		if (!token) throw new Error("Missing github-token");

		const repoFull = process.env.GITHUB_REPOSITORY || "";
		const [owner, repo] = repoFull.split("/");
		if (!owner || !repo)
			throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);

		const baseBranch = core.getInput("base-branch") || "main";
		const releaseBranch = core.getInput("release-branch") || "release/pr";
		const labelMajor = core.getInput("label-major") || "bump:major";
		const labelMinor = core.getInput("label-minor") || "bump:minor";
		const labelPatch = core.getInput("label-patch") || "bump:patch";
		const tagPrefix = core.getInput("tag-prefix") || "v";
		const releaseCfgPath =
			core.getInput("configuration_file_path") || undefined;

		const eventName = ghContext.eventName;
		core.debug(`Event name: ${eventName}`);
		core.debug(
			`Configuration: baseBranch=${baseBranch}, releaseBranch=${releaseBranch}, tagPrefix=${tagPrefix}`,
		);

		const octokit = getOctokit(token);

		if (eventName === "pull_request") {
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
			if (pr.head.ref !== releaseBranch) {
				core.info(
					`PR is not from release branch (${pr.head.ref} != ${releaseBranch}) - skipping`,
				);
				setOutputWithLog("state", "noop");
				return;
			}
			core.info(`Processing release PR #${pr.number}`);
			const currentTag = await latestTag(octokit, owner, repo, tagPrefix).catch(
				() => null,
			);
			core.info(`Current tag: ${currentTag || "(none)"}`);
			const bumpLevel = detectBump(pr.labels || [], {
				labelMajor,
				labelMinor,
				labelPatch,
			});
			core.info(`Detected bump level: ${bumpLevel}`);
			const nextTag =
				bumpLevel === "unknown"
					? ""
					: calcNext(tagPrefix, currentTag, bumpLevel);
			if (nextTag) core.info(`Next tag will be: ${nextTag}`);
			const notes = await generateNotes(octokit, owner, repo, {
				tagName: nextTag || `${tagPrefix}next`,
				target: baseBranch,
				previousTagName: currentTag || undefined,
				configuration_file_path: releaseCfgPath,
			}).catch(() => "");
			const { title, body } = buildPRText({
				owner,
				repo,
				baseBranch,
				currentTag,
				nextTag,
				notes,
			});
			core.info(`Updating PR #${pr.number} with new title and body`);
			await octokit.rest.pulls.update({
				owner,
				repo,
				pull_number: pr.number,
				title,
				body,
			});
			core.info("PR updated successfully");
			setOutputWithLog("state", "pr_changed");
			setOutputWithLog("pr_number", String(pr.number));
			setOutputWithLog("pr_url", pr.html_url);
			setOutputWithLog("pr_branch", releaseBranch);
			setOutputWithLog("current_tag", currentTag || "");
			setOutputWithLog("next_tag", nextTag || "");
			setOutputWithLog("bump_level", bumpLevel);
			setOutputWithLog("release_notes", notes);
			return;
		}

		if (eventName === "push") {
			core.info("Processing push event");
			const pushPayload = ghContext.payload as PushEvent;
			const headSha = pushPayload.after;
			core.debug(`Head SHA: ${headSha}`);
			let relPR: WebhookPullRequestEvent["pull_request"] | undefined;
			try {
				const { data } =
					await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
						owner,
						repo,
						commit_sha: headSha,
					});
				relPR = (data || []).find((p) => p.head?.ref === releaseBranch) as
					| WebhookPullRequestEvent["pull_request"]
					| undefined;
			} catch {}
			if (relPR) {
				core.info(`Found merged release PR: #${relPR.number}`);
				const currentTag = await latestTag(
					octokit,
					owner,
					repo,
					tagPrefix,
				).catch(() => null);
				core.info(`Current tag: ${currentTag || "(none)"}`);
				const bumpLevel = detectBump(relPR.labels || [], {
					labelMajor,
					labelMinor,
					labelPatch,
				});
				core.info(`Detected bump level: ${bumpLevel}`);
				const nextTag =
					bumpLevel === "unknown"
						? ""
						: calcNext(tagPrefix, currentTag, bumpLevel);
				if (nextTag) core.info(`Release required for: ${nextTag}`);
				setOutputWithLog("state", "release_required");
				setOutputWithLog("pr_number", "");
				setOutputWithLog("pr_url", "");
				setOutputWithLog("pr_branch", "");
				setOutputWithLog("current_tag", currentTag || "");
				setOutputWithLog("next_tag", nextTag || "");
				setOutputWithLog("bump_level", bumpLevel);
				setOutputWithLog("release_notes", "");
				return;
			}

			core.info("Checking for existing release PR");
			const currentTag = await latestTag(octokit, owner, repo, tagPrefix).catch(
				() => null,
			);
			core.info(`Current tag: ${currentTag || "(none)"}`);
			const existing = await findOpenReleasePR(octokit, {
				owner,
				repo,
				baseBranch,
				releaseBranch,
			}).catch(() => null);

			if (existing && existing.number) {
				core.info(`Found existing release PR #${existing.number} - updating`);
				const bumpLevel = detectBump(existing.labels || [], {
					labelMajor,
					labelMinor,
					labelPatch,
				});
				core.info(`Detected bump level: ${bumpLevel}`);
				const nextTag =
					bumpLevel === "unknown"
						? ""
						: calcNext(tagPrefix, currentTag, bumpLevel);
				if (nextTag) core.info(`Next tag will be: ${nextTag}`);
				const notes = await generateNotes(octokit, owner, repo, {
					tagName: nextTag || `${tagPrefix}next`,
					target: baseBranch,
					previousTagName: currentTag || undefined,
					configuration_file_path: releaseCfgPath,
				}).catch(() => "");
				const { title, body } = buildPRText({
					owner,
					repo,
					baseBranch,
					currentTag,
					nextTag,
					notes,
				});
				core.info(`Updating PR #${existing.number}`);
				const { data: updated } = await octokit.rest.pulls.update({
					owner,
					repo,
					pull_number: existing.number,
					title,
					body,
				});
				core.info("PR updated successfully");
				setOutputWithLog("state", "pr_changed");
				setOutputWithLog("pr_number", String(updated.number));
				setOutputWithLog("pr_url", updated.html_url);
				setOutputWithLog("pr_branch", releaseBranch);
				setOutputWithLog("current_tag", currentTag || "");
				setOutputWithLog("next_tag", nextTag || "");
				setOutputWithLog("bump_level", bumpLevel);
				setOutputWithLog("release_notes", notes);
				return;
			}

			core.info("No existing release PR found - creating new one");
			await ensureReleaseBranch(octokit, owner, repo, {
				baseBranch,
				releaseBranch,
			});
			const bumpLevel: BumpLevel = "unknown";
			const nextTag = "";
			core.info("Release branch ensured, creating PR with unknown bump level");
			const notes = await generateNotes(octokit, owner, repo, {
				tagName: `${tagPrefix}next`,
				target: baseBranch,
				previousTagName: currentTag || undefined,
				configuration_file_path: releaseCfgPath,
			}).catch(() => "");
			const { title, body } = buildPRText({
				owner,
				repo,
				baseBranch,
				currentTag,
				nextTag,
				notes,
			});
			core.info(`Creating release PR from ${releaseBranch} to ${baseBranch}`);
			const { data: created } = await octokit.rest.pulls.create({
				owner,
				repo,
				title,
				head: releaseBranch,
				base: baseBranch,
				body,
				draft: false,
			});
			core.info(`Created release PR #${created.number}`);
			// Add release-pr label to the created PR
			await ensureAndAddLabel(
				octokit,
				owner,
				repo,
				created.number,
				"release-pr",
			);
			setOutputWithLog("state", "pr_changed");
			setOutputWithLog("pr_number", String(created.number));
			setOutputWithLog("pr_url", created.html_url);
			setOutputWithLog("pr_branch", releaseBranch);
			setOutputWithLog("current_tag", currentTag || "");
			setOutputWithLog("next_tag", nextTag || "");
			setOutputWithLog("bump_level", bumpLevel);
			setOutputWithLog("release_notes", notes);
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
	prefix: string,
): Promise<string | null> {
	core.debug(`Fetching tags with prefix: ${prefix}`);
	const tags = await octokit.paginate(octokit.rest.repos.listTags, {
		owner,
		repo,
		per_page: 100,
	});
	const semvers = (tags || [])
		.map((t) => t.name)
		.filter((n) => n && n.startsWith(prefix))
		.map((n) => ({ name: n, v: parseSemVer(n.slice(prefix.length)) }))
		.filter((x): x is { name: string; v: SemVer } => !!x.v)
		.sort((a, b) => cmpSemVer(a.v, b.v));
	const latest = semvers.length ? semvers[semvers.length - 1].name : null;
	core.debug(
		`Found ${semvers.length} semver tags, latest: ${latest || "none"}`,
	);
	return latest;
}

type SemVer = { major: number; minor: number; patch: number };
function parseSemVer(s: string): SemVer | null {
	const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function cmpSemVer(a: SemVer, b: SemVer): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
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
	currentTag: string | null,
	bumpLevel: BumpLevel,
): string {
	const cur =
		currentTag && currentTag.startsWith(prefix)
			? parseSemVer(currentTag.slice(prefix.length))
			: { major: 0, minor: 0, patch: 0 };
	if (!cur)
		throw new Error(`Current tag is not SemVer with prefix: ${currentTag}`);
	let { major, minor, patch } = cur;
	if (bumpLevel === "major") {
		major += 1;
		minor = 0;
		patch = 0;
	} else if (bumpLevel === "minor") {
		minor += 1;
		patch = 0;
	} else if (bumpLevel === "patch") {
		patch += 1;
	}
	return `${prefix}${major}.${minor}.${patch}`;
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
		} catch (error) {
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
	currentTag,
	nextTag,
	notes,
}: {
	owner: string;
	repo: string;
	baseBranch: string;
	currentTag: string | null;
	nextTag: string;
	notes: string;
}) {
	const known = !!nextTag;
	const title = known ? `Release for ${nextTag}` : "Release for new version";
	const parts: string[] = [];
	parts.push("## 🚀 Release PR");
	parts.push("");
	parts.push("_Prepared by create-release-pr_");
	parts.push("");

	// Build the release info table
	parts.push("### Release Information");
	parts.push("");
	parts.push("| | |");
	parts.push("|---|---|");

	// Current tag with link to release page
	if (currentTag) {
		parts.push(`| **Current Release** | [${currentTag}](https://github.com/${owner}/${repo}/releases/tag/${currentTag}) |`);
	} else {
		parts.push("| **Current Release** | (none) |");
	}

	// Next tag
	parts.push(`| **Next Release** | ${nextTag || "⚠️ TBD - Add label: `bump:major`, `bump:minor`, or `bump:patch`"} |`);

	// Full changelog link
	if (currentTag) {
		parts.push(`| **Changes** | [View Diff](https://github.com/${owner}/${repo}/compare/${currentTag}...${baseBranch}) |`);
	}

	parts.push("");
	parts.push("---");
	parts.push("");
	parts.push("### 📝 Release Notes Preview");
	parts.push("");
	parts.push("> **Note:** This is a preview of the release notes that will be published when this PR is merged.");
	parts.push("> Links in the changelog may not work until the release is created.");
	parts.push("");
	parts.push("---");
	parts.push("");
	if (notes) {
		parts.push(notes);
	} else {
		parts.push("_Release notes will be generated here_");
	}
	parts.push("");
	parts.push("---");

	return { title, body: parts.join("\n") };
}

void run();
