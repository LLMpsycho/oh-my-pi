import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	getMemoryRoot,
	startMemoryStartupTask,
} from "@oh-my-pi/pi-coding-agent/memories";
import * as memoryStorage from "@oh-my-pi/pi-coding-agent/memories/storage";
import { resolveMemoryProjectIdentity } from "@oh-my-pi/pi-coding-agent/memory-project-identity";
import { getAgentDbPath, Snowflake } from "@oh-my-pi/pi-utils";

interface SessionFixture {
	agentDir: string;
	sessionDir: string;
	sessionFile: string;
	settings: Settings;
	session: any;
	modelRegistry: any;
	model: Model;
}

const createdDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	createdDirs.add(dir);
	return dir;
}

function createModel(id = "test-model"): Model {
	return {
		provider: "openai",
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

function createModelRegistry(model: Model): any {
	return {
		find: vi.fn(() => model),
		getAll: vi.fn(() => [model]),
		getApiKey: vi.fn(async () => "test-api-key"),
		resolver: vi.fn(() => async () => "test-api-key"),
	};
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<SessionFixture> {
	const agentDir = await makeTempDir("memories-runtime-agent");
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "current-session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);

	const settings = Settings.isolated({
		"memories.enabled": true,
		"memories.minRolloutIdleHours": 0,
		"memories.maxRolloutsPerStartup": 16,
		"memories.threadScanLimit": 64,
		"memories.phase2HeartbeatSeconds": 1,
		...(overrides ?? {}),
	});
	const model = createModel();
	const modelRegistry = createModelRegistry(model);
	const refreshBaseSystemPrompt = vi.fn(async () => undefined);
	const session = {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionDir: () => sessionDir,
			getSessionId: () => "current-thread",
			getCwd: () => agentDir,
		},
		settings,
		model,
		modelRegistry,
		refreshBaseSystemPrompt,
	};

	return { agentDir, sessionDir, sessionFile, settings, session, modelRegistry, model };
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(20);
	}
	throw lastError;
}

describe("memories runtime", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		// Prevent getXdgDataPath/getXdgStatePath from resolving to real user data
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.env.XDG_DATA_HOME = savedXdgData;
		process.env.XDG_STATE_HOME = savedXdgState;
		for (const dir of createdDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("startup gating skips when disabled or subagent depth", async () => {
		const disabled = await createFixture({ "memories.enabled": false });
		const openSpy = vi.spyOn(memoryStorage, "openMemoryDb");
		startMemoryStartupTask({
			session: disabled.session,
			settings: disabled.settings,
			modelRegistry: disabled.modelRegistry,
			agentDir: disabled.agentDir,
			taskDepth: 0,
		});
		expect(openSpy).not.toHaveBeenCalled();

		const subagent = await createFixture({ "memories.enabled": true });
		startMemoryStartupTask({
			session: subagent.session,
			settings: subagent.settings,
			modelRegistry: subagent.modelRegistry,
			agentDir: subagent.agentDir,
			taskDepth: 1,
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("startup gating skips when DB is unavailable", async () => {
		const fx = await createFixture();
		vi.spyOn(memoryStorage, "openMemoryDb").mockImplementation(() => {
			throw new Error("db unavailable");
		});
		const stage1Spy = vi.spyOn(ai, "completeSimple");

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await Bun.sleep(50);
		expect(stage1Spy).not.toHaveBeenCalled();
	});

	test("runs phase1 to phase2 and writes consolidated outputs", async () => {
		const fx = await createFixture();
		const rolloutPath = path.join(fx.sessionDir, "thread-a.jsonl");
		const rolloutRows = [
			{ type: "session", id: "thread-a", cwd: fx.agentDir },
			{ type: "message", message: { role: "user", content: "summarize this rollout" } },
		];
		await fs.writeFile(rolloutPath, `${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`);

		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							rollout_summary: "Rollout summary A",
							rollout_slug: "thread-a-rollout",
							raw_memory: "Raw memory A",
						}),
					},
				],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
			} as any)
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							memory_md: "# Memory\n\nConsolidated body",
							memory_summary: "Consolidated summary",
							skills: [{ name: "deploy-playbook", content: "# Deploy\nUse blue/green." }],
						}),
					},
				],
			} as any);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await waitFor(async () => {
			expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe(
				"# Memory\n\nConsolidated body",
			);
			expect((await fs.readFile(path.join(memoryRoot, "memory_summary.md"), "utf8")).trim()).toBe(
				"Consolidated summary",
			);
			expect(
				(await fs.readFile(path.join(memoryRoot, "skills", "deploy-playbook", "SKILL.md"), "utf8")).trim(),
			).toBe("# Deploy\nUse blue/green.");
			expect(fx.session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		});
		expect(ai.completeSimple).toHaveBeenCalled();
		expect(ai.completeSimple).toHaveBeenCalledTimes(2);
	});

	test("clamps stage1 and phase2 reasoning effort against the model's supported range", async () => {
		// Regression for #1480: memory pipeline hardcoded `Effort.Low`/`Effort.Medium`,
		// which `requireSupportedEffort` rejects on models whose supported range starts
		// above `low` (e.g. deepseek-v4-pro → [high, xhigh]). The fix routes both call
		// sites through `clampThinkingLevelForModel`, lifting the requested effort to
		// the model's floor instead of throwing.
		const fx = await createFixture();
		const constrainedModel: Model = {
			...fx.model,
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.High, Effort.XHigh] },
		};
		fx.session.model = constrainedModel;
		fx.modelRegistry.find = vi.fn(() => constrainedModel);
		fx.modelRegistry.getAll = vi.fn(() => [constrainedModel]);

		const rolloutPath = path.join(fx.sessionDir, "thread-constrained.jsonl");
		const rolloutRows = [
			{ type: "session", id: "thread-constrained", cwd: fx.agentDir },
			{ type: "message", message: { role: "user", content: "summarize this rollout" } },
		];
		await fs.writeFile(rolloutPath, `${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`);

		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							rollout_summary: "Rollout summary",
							rollout_slug: "thread-constrained",
							raw_memory: "Raw memory",
						}),
					},
				],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			} as any)
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							memory_md: "# Memory\n\nBody",
							memory_summary: "Summary",
							skills: [],
						}),
					},
				],
			} as any);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await waitFor(async () => {
			expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe("# Memory\n\nBody");
		});

		expect(spy).toHaveBeenCalledTimes(2);
		// stage1 requested `low`, phase2 requested `medium`; both must clamp up to the
		// model's floor (`high`) instead of being passed through and throwing.
		expect(spy.mock.calls[0]?.[2]?.reasoning).toBe(Effort.High);
		expect(spy.mock.calls[1]?.[2]?.reasoning).toBe(Effort.High);
	});

	test("explicit project key only rewrites matching histories in shared session dirs", async () => {
		const fx = await createFixture({
			"memory.projectKey": "github.com/current/repo",
			"memories.minRolloutIdleHours": 999,
		});
		const unrelatedCwd = await makeTempDir("memories-runtime-unrelated");
		const unrelatedSession = path.join(fx.sessionDir, "unrelated-session.jsonl");
		await fs.writeFile(
			unrelatedSession,
			`${JSON.stringify({ type: "session", id: "unrelated-thread", cwd: unrelatedCwd })}\n`,
		);
		const sameProjectSession = path.join(fx.sessionDir, "same-project-session.jsonl");
		await fs.writeFile(
			sameProjectSession,
			`${JSON.stringify({
				type: "session",
				id: "same-project-thread",
				cwd: fx.session.sessionManager.getCwd(),
			})}\n`,
		);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(() => {
			const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
			try {
				const unrelatedRow = db.prepare("SELECT cwd FROM threads WHERE id = ?").get("unrelated-thread") as
					| { cwd: string }
					| undefined;
				const sameProjectRow = db.prepare("SELECT cwd FROM threads WHERE id = ?").get("same-project-thread") as
					| { cwd: string }
					| undefined;
				expect(unrelatedRow?.cwd).toBe(resolveMemoryProjectIdentity(unrelatedCwd).key);
				expect(sameProjectRow?.cwd).toBe("github.com/current/repo");
			} finally {
				memoryStorage.closeMemoryDb(db);
			}
		});
	});

	test("explicit project key migrates legacy stored thread outputs without the session file", async () => {
		const fx = await createFixture({
			"memory.projectKey": "github.com/current/repo",
			"memories.minRolloutIdleHours": 999,
		});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce({
			stopReason: "end_turn",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						memory_md: "# Memory\n\nMigrated",
						memory_summary: "Migrated summary",
						skills: [],
					}),
				},
			],
		} as any);

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.upsertThreads(db, [
			{
				id: "legacy-thread",
				updatedAt: 100,
				rolloutPath: "/tmp/missing-legacy-thread.jsonl",
				cwd: fx.session.sessionManager.getCwd(),
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("legacy-thread", 100, "legacy raw", "legacy summary", null, 100);
		memoryStorage.closeMemoryDb(db);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd(), "github.com/current/repo");
		await waitFor(async () => {
			expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe("# Memory\n\nMigrated");
			expect(await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8")).toContain("legacy raw");
			const scopedDb = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
			try {
				const row = scopedDb.prepare("SELECT cwd FROM threads WHERE id = ?").get("legacy-thread") as
					| { cwd: string }
					| undefined;
				expect(row?.cwd).toBe("github.com/current/repo");
			} finally {
				memoryStorage.closeMemoryDb(scopedDb);
			}
		});
	});

	test("auto project identity migrates legacy stored thread outputs without the session file", async () => {
		const fx = await createFixture({ "memories.minRolloutIdleHours": 999 });
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce({
			stopReason: "end_turn",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						memory_md: "# Memory\n\nAuto migrated",
						memory_summary: "Auto migrated summary",
						skills: [],
					}),
				},
			],
		} as any);
		const projectKey = resolveMemoryProjectIdentity(fx.session.sessionManager.getCwd()).key;

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.upsertThreads(db, [
			{
				id: "auto-legacy-thread",
				updatedAt: 100,
				rolloutPath: "/tmp/missing-auto-legacy-thread.jsonl",
				cwd: fx.session.sessionManager.getCwd(),
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("auto-legacy-thread", 100, "auto legacy raw", "auto legacy summary", null, 100);
		memoryStorage.closeMemoryDb(db);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await waitFor(async () => {
			expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe(
				"# Memory\n\nAuto migrated",
			);
			const scopedDb = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
			try {
				const row = scopedDb.prepare("SELECT cwd FROM threads WHERE id = ?").get("auto-legacy-thread") as
					| { cwd: string }
					| undefined;
				expect(row?.cwd).toBe(projectKey);
			} finally {
				memoryStorage.closeMemoryDb(scopedDb);
			}
		});
	});

	test("phase2 sync prunes stale summaries and preserves raw memory ordering", async () => {
		const fx = await createFixture();
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						memory_md: "# Memory\n\nMerged",
						memory_summary: "Merged summary",
						skills: [{ name: "ops", content: "# Ops\nRunbook" }],
					}),
				},
			],
		} as any);

		const projectKey = resolveMemoryProjectIdentity(fx.session.sessionManager.getCwd()).key;
		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.upsertThreads(db, [
			{
				id: "thread-a",
				updatedAt: 100,
				rolloutPath: "/tmp/a.jsonl",
				cwd: projectKey,
				sourceKind: "cli",
			},
			{
				id: "thread-b",
				updatedAt: 200,
				rolloutPath: "/tmp/b.jsonl",
				cwd: projectKey,
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-a", 100, "raw-a", "summary-a", "alpha", 100);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-b", 200, "raw-b", "summary-b", "beta", 200);
		memoryStorage.enqueueGlobalWatermark(db, 200, projectKey, {
			forceDirtyWhenNotAdvanced: true,
		});
		memoryStorage.closeMemoryDb(db);

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await fs.mkdir(path.join(memoryRoot, "rollout_summaries"), { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "rollout_summaries", "old.md"), "stale");

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(async () => {
			const files = await fs.readdir(path.join(memoryRoot, "rollout_summaries"));
			expect(files.includes("old.md")).toBe(false);
			expect(files).toEqual(expect.arrayContaining(["thread-a-alpha.md", "thread-b-beta.md"]));
			const raw = await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8");
			expect(raw.indexOf("## thread-b")).toBeLessThan(raw.indexOf("## thread-a"));
		});
	});

	test("phase2 empty-input cleanup removes consolidated files and skills dir", async () => {
		const fx = await createFixture();
		const projectKey = resolveMemoryProjectIdentity(fx.session.sessionManager.getCwd()).key;
		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await fs.mkdir(path.join(memoryRoot, "skills", "legacy"), { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "MEMORY.md"), "legacy memory");
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "legacy summary");
		await fs.writeFile(path.join(memoryRoot, "skills", "legacy", "SKILL.md"), "legacy skill");

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.enqueueGlobalWatermark(db, 300, projectKey, {
			forceDirtyWhenNotAdvanced: true,
		});
		memoryStorage.closeMemoryDb(db);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(async () => {
			expect(await Bun.file(path.join(memoryRoot, "MEMORY.md")).exists()).toBe(false);
			expect(await Bun.file(path.join(memoryRoot, "memory_summary.md")).exists()).toBe(false);
			expect(await Bun.file(path.join(memoryRoot, "skills")).exists()).toBe(false);
			expect((await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8")).trim()).toBe(
				"# Raw Memories\n\nNo raw memories yet.",
			);
		});
	});

	test("clearMemoryData removes configured project artifacts and legacy cwd artifacts", async () => {
		const fx = await createFixture({ "memory.projectKey": "github.com/current/repo" });
		const cwd = fx.session.sessionManager.getCwd();
		const projectRoot = getMemoryRoot(fx.agentDir, cwd, "github.com/current/repo");
		const legacyRoot = path.join(fx.agentDir, "memories", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.mkdir(legacyRoot, { recursive: true });
		await fs.writeFile(path.join(projectRoot, "memory_summary.md"), "project");
		await fs.writeFile(path.join(legacyRoot, "memory_summary.md"), "legacy");

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.upsertThreads(db, [
			{ id: "legacy-thread", updatedAt: 100, rolloutPath: "/tmp/legacy.jsonl", cwd, sourceKind: "cli" },
			{
				id: "project-thread",
				updatedAt: 101,
				rolloutPath: "/tmp/project.jsonl",
				cwd: "github.com/current/repo",
				sourceKind: "cli",
			},
			{
				id: "other-thread",
				updatedAt: 102,
				rolloutPath: "/tmp/other.jsonl",
				cwd: "github.com/other/repo",
				sourceKind: "cli",
			},
		]);
		memoryStorage.closeMemoryDb(db);

		await clearMemoryData(fx.agentDir, cwd, "github.com/current/repo");

		expect(await Bun.file(projectRoot).exists()).toBe(false);
		expect(await Bun.file(legacyRoot).exists()).toBe(false);
		const scopedDb = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		try {
			const rows = scopedDb.prepare("SELECT id FROM threads ORDER BY id").all() as { id: string }[];
			expect(rows.map(row => row.id)).toEqual(["other-thread"]);
		} finally {
			memoryStorage.closeMemoryDb(scopedDb);
		}
	});
});

describe("buildMemoryToolDeveloperInstructions", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.env.XDG_DATA_HOME = savedXdgData;
		process.env.XDG_STATE_HOME = savedXdgState;
		for (const dir of createdDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("returns undefined for missing or empty summaries", async () => {
		const agentDir = await makeTempDir("memories-runtime-instructions");
		const settings = Settings.isolated({ "memory.backend": "local" });

		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings)).toBeUndefined();

		const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "   \n\t\n");
		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings)).toBeUndefined();
	});

	test("renders payload with truncation for non-empty summary", async () => {
		const agentDir = await makeTempDir("memories-runtime-instructions");
		const settings = Settings.isolated({
			"memory.backend": "local",
			"memories.summaryInjectionTokenLimit": 8,
		});
		const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(
			path.join(memoryRoot, "memory_summary.md"),
			`${"A".repeat(120)}\n${"B".repeat(120)}\n${"C".repeat(120)}`,
		);

		const payload = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(payload).toBeDefined();
		expect(payload).toContain("memory://root/memory_summary.md");
		expect(payload).not.toContain(memoryRoot);
		expect(payload).toContain("...[truncated]...");
	});
});
