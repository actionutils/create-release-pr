import { run } from "@actionutils/gh-release-notes";

export interface ReleaseNotesOptions {
	owner: string;
	repo: string;
	token: string;
	tagName: string;
	target: string;
	previousTagName?: string;
	configurationFilePath?: string;
	template?: string;
}

export async function generateReleaseNotes(
	options: ReleaseNotesOptions,
	generate: typeof run = run,
): Promise<string> {
	const result = await generate({
		repo: `${options.owner}/${options.repo}`,
		token: options.token,
		tag: options.tagName,
		target: options.target,
		prevTag: options.previousTagName,
		configRef: options.target,
		config: options.configurationFilePath
			? `pkg:github/${options.owner}/${options.repo}@${encodeURIComponent(options.target)}#${options.configurationFilePath}`
			: undefined,
		template: options.template,
		includeAllData: !!options.template,
		sponsorFetchMode: "none",
	});
	return result.release.body || "";
}
