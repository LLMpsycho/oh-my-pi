import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged, while the project root is resolved from stable memory
 * project identity instead of cwd/worktree path. On top of it, `save()` persists
 * `learn`-tool lessons to `learned.md` (so `status()` reports `writable: true`);
 * structured search is still unavailable.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd, session?.settings?.get("memory.projectKey"));
	},
	async enqueue(agentDir, cwd, session) {
		enqueueMemoryConsolidation(agentDir, cwd, undefined, session?.settings?.get("memory.projectKey"));
	},
	async save(context, input) {
		return saveLearnedLesson(
			context.agentDir,
			context.cwd,
			input,
			context.session?.settings?.get("memory.projectKey"),
		);
	},
	async status() {
		return {
			backend: "local" as const,
			active: true,
			writable: true,
			searchable: false,
			message:
				"Local rollout-summary memory is active; lessons from the `learn` tool are saved to learned.md. Structured search is not available.",
		};
	},
};
