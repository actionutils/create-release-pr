import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunOptions, RunResult } from "@actionutils/gh-release-notes";
import { generateReleaseNotes } from "./release-notes";

const options = {
	owner: "acme",
	repo: "demo",
	token: "test-token",
	tagName: "v1.1.0",
	target: "main",
};

void test("default generation keeps optional inputs unset and avoids sponsor scraping", async () => {
	let received: RunOptions | undefined;
	await generateReleaseNotes(options, async (input) => {
		received = input;
		return { release: { body: "Default notes" } } as RunResult;
	});
	assert.equal(received?.prevTag, undefined);
	assert.equal(received?.config, undefined);
	assert.equal(received?.configRef, "main");
	assert.equal(received?.includeAllData, false);
	assert.equal(received?.sponsorFetchMode, "none");
});

void test("passes the caller's token and repository configuration ref to the library", async () => {
	let received: RunOptions | undefined;
	const body = "## Changes\nEOF\n`literal`";
	const notes = await generateReleaseNotes(
		{
			...options,
			previousTagName: "v1.0.0",
			configurationFilePath: ".github/custom.yml",
			target: "release/next",
			template: "templates/notes.jinja",
		},
		async (input) => {
			received = input;
			return { release: { body } } as RunResult;
		},
	);
	assert.equal(notes, body);
	assert.equal(received?.token, "test-token");
	assert.equal(received?.repo, "acme/demo");
	assert.equal(received?.prevTag, "v1.0.0");
	assert.equal(received?.configRef, "release/next");
	assert.equal(
		received?.config,
		"pkg:github/acme/demo@release%2Fnext#.github/custom.yml",
	);
	assert.equal(received?.template, "templates/notes.jinja");
	assert.equal(received?.sponsorFetchMode, "none");
});

void test("generation failures remain visible to the action's warning handler", async () => {
	await assert.rejects(
		generateReleaseNotes(options, async () => {
			throw new Error("API failed");
		}),
		/API failed/,
	);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

void test("the ncc bundle renders templates using the packaged WASM engine", async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), "create-release-pr-notes-"),
	);
	try {
		const template = path.join(directory, "notes.jinja");
		await writeFile(
			template,
			"{{ owner }}/{{ repo }}: {{ mergedPullRequests | length }} PRs",
		);
		globalThis.fetch = async (input) => {
			const url = new URL(
				typeof input === "string" || input instanceof URL ? input : input.url,
			);
			let body: unknown;
			if (url.pathname.includes("/contents/"))
				return new Response("Not found", { status: 404 });
			if (url.pathname === "/repos/acme/demo")
				body = { default_branch: "main" };
			else if (url.pathname === "/repos/acme/demo/releases") body = [];
			else if (url.pathname.includes("/git/matching-refs/")) body = [];
			else if (url.pathname === "/graphql")
				body = {
					data: {
						search: {
							nodes: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				};
			else throw new Error(`Unexpected request: ${url}`);
			return new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			});
		};
		assert.equal(
			await generateReleaseNotes({ ...options, template }),
			"acme/demo: 0 PRs",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
