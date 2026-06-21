import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "./config/settings";
import { computeBankScope } from "./hindsight/bank";
import { type HindsightConfig, loadHindsightConfig } from "./hindsight/config";
import { getMemoryRoot } from "./memories";
import { resolveMemoryProjectIdentity } from "./memory-project-identity";
import { loadMnemopiConfig } from "./mnemopi/config";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "true";
delete process.env.XDG_CONFIG_HOME;

const baseHindsightConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: "omp",
	bankIdPrefix: "",
	scoping: "per-project-tagged",
	projectKey: null,
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

async function withTempRepo(
	callback: (roots: { main: string; linked: string }) => void | Promise<void>,
): Promise<void> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-project-identity-"));
	try {
		const main = path.join(baseDir, "repo-main");
		const linked = path.join(baseDir, "repo-feature");
		await fs.mkdir(main, { recursive: true });
		runGit(main, ["-c", "init.defaultBranch=main", "init"]);
		await fs.writeFile(path.join(main, "README.md"), "hello\n");
		runGit(main, ["add", "README.md"]);
		runGit(main, ["commit", "-m", "base"]);
		runGit(main, ["worktree", "add", linked, "-b", "feature"]);
		await callback({ main, linked });
	} finally {
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

describe("memory project identity", () => {
	it("uses an explicit project identity for Hindsight tags and local memory roots", () => {
		const identity = resolveMemoryProjectIdentity("/tmp/any-worktree", " https://github.com/Org/Repo.git ");

		expect(identity.key).toBe("github.com/org/repo");
		expect(identity.segment).toStartWith("github-com-org-repo-");
		expect(identity.source).toBe("explicit");
		expect(
			computeBankScope(baseHindsightConfig({ projectKey: "https://github.com/Org/Repo.git" }), "/tmp/a"),
		).toEqual({
			bankId: "omp",
			retainTags: ["project:github.com/org/repo"],
			recallTags: ["project:github.com/org/repo"],
			recallTagsMatch: "any",
		});
		const memoryRoot = getMemoryRoot("/tmp/agent", "/tmp/a", "https://github.com/Org/Repo.git");
		expect(path.basename(memoryRoot)).toStartWith("--github-com-org-repo-");
		expect(memoryRoot).toEndWith("--");
	});

	it("prefers an upstream git remote so forks share the canonical project identity", async () => {
		await withTempRepo(({ main, linked }) => {
			runGit(main, ["remote", "add", "origin", "git@github.com:Fork/Repo.git"]);
			runGit(main, ["remote", "add", "upstream", "https://github.com/Org/Repo.git"]);

			const mainIdentity = resolveMemoryProjectIdentity(main);
			const linkedIdentity = resolveMemoryProjectIdentity(linked);

			expect(mainIdentity.key).toBe("github.com/org/repo");
			expect(mainIdentity.segment).toStartWith("github-com-org-repo-");
			expect(mainIdentity.source).toBe("git-remote");
			expect(linkedIdentity).toEqual(mainIdentity);
		});
	});

	it("ignores file remotes instead of treating local paths as hosted project identities", async () => {
		await withTempRepo(({ main }) => {
			runGit(main, ["remote", "add", "origin", "file:///tmp/Repo.git"]);

			const identity = resolveMemoryProjectIdentity(main);

			expect(identity.source).toBe("git-common-dir");
			expect(identity.key).toStartWith("local/repo-main/");
		});
	});

	it("uses the cwd path hash for non-git directories with the same basename", async () => {
		const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-cwd-identity-"));
		try {
			const first = path.join(baseDir, "one", "app");
			const second = path.join(baseDir, "two", "app");
			await fs.mkdir(first, { recursive: true });
			await fs.mkdir(second, { recursive: true });

			const firstIdentity = resolveMemoryProjectIdentity(first);
			const secondIdentity = resolveMemoryProjectIdentity(second);

			expect(firstIdentity.source).toBe("cwd");
			expect(secondIdentity.source).toBe("cwd");
			expect(firstIdentity.key).toStartWith("cwd/app/");
			expect(secondIdentity.key).toStartWith("cwd/app/");
			expect(secondIdentity.key).not.toBe(firstIdentity.key);
		} finally {
			await fs.rm(baseDir, { recursive: true, force: true });
		}
	});

	it("adds a hash suffix so colliding normalized project segments stay distinct", () => {
		const first = resolveMemoryProjectIdentity("/tmp/any-worktree", "github.com/org/repo-a");
		const second = resolveMemoryProjectIdentity("/tmp/any-worktree", "github.com/org-repo/a");

		expect(first.key).toBe("github.com/org/repo-a");
		expect(second.key).toBe("github.com/org-repo/a");
		expect(first.segment).toStartWith("github-com-org-repo-a-");
		expect(second.segment).toStartWith("github-com-org-repo-a-");
		expect(second.segment).not.toBe(first.segment);
	});

	it("uses the same local git identity for linked worktrees without remotes", async () => {
		await withTempRepo(({ main, linked }) => {
			const mainIdentity = resolveMemoryProjectIdentity(main);
			const linkedIdentity = resolveMemoryProjectIdentity(linked);

			expect(mainIdentity.source).toBe("git-common-dir");
			expect(mainIdentity.key).toStartWith("local/repo-main/");
			expect(linkedIdentity).toEqual(mainIdentity);
		});
	});

	it("loads the explicit identity from settings and env for memory backends", () => {
		const settings = Settings.isolated({
			"memory.projectKey": "github.com/Org/Repo.git",
			"mnemopi.scoping": "per-project-tagged",
			"hindsight.scoping": "per-project-tagged",
		});

		expect(loadHindsightConfig(settings, {}).projectKey).toBe("github.com/Org/Repo.git");
		expect(loadHindsightConfig(settings, { OMP_PROJECT_KEY: "https://gitlab.com/Team/App" }).projectKey).toBe(
			"https://gitlab.com/Team/App",
		);

		const mnemopiConfig = loadMnemopiConfig(settings, "/tmp/agent");
		expect(mnemopiConfig.retainBank).toStartWith("github-com-org-repo-");
		expect(mnemopiConfig.recallBanks?.[0]).toStartWith("github-com-org-repo-");
		expect(mnemopiConfig.recallBanks?.[1]).toBe("default");
	});
});
