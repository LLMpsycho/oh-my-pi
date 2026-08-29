/**
 * Sharpshooter storage layout.
 *
 * Everything lives home-scoped under `<agentDir>/memories/sharpshooter/<bank>/`
 * (mnemopi-style project bank id, never the project working tree):
 *
 * - `architecture.md` / `product.md` / `style.md` — the memory files
 * - `queue/<sessionId>/<ts36>-<nonce>.json`        — one queued delta per file
 * - `state.json`                                   — consolidation bookkeeping
 * - `consolidate.lock`                             — cross-process single-writer lock
 */

import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import { projectBankSegment } from "../mnemopi/config";
import type { SharpshooterState } from "./types";

/** Root for every sharpshooter bank. */
export function sharpshooterRoot(agentDir: string): string {
	return path.join(getMemoriesDir(agentDir), "sharpshooter");
}

/** Stable per-project bank id from memory project identity (see {@link projectBankSegment}). */
export function sharpshooterBankId(cwd: string, projectKey?: string | null): string {
	return projectBankSegment(path.resolve(cwd || "."), projectKey);
}

/** Bank directory for a project. */
export function sharpshooterBankDir(agentDir: string, cwd: string, projectKey?: string | null): string {
	return path.join(sharpshooterRoot(agentDir), sharpshooterBankId(cwd, projectKey));
}

/** Queue root of a bank; one subdirectory per session. */
export function sharpshooterQueueDir(agentDir: string, cwd: string, projectKey?: string | null): string {
	return path.join(sharpshooterBankDir(agentDir, cwd, projectKey), "queue");
}

/** Path of one memory file inside a bank. */
export function sharpshooterMemoryFilePath(
	agentDir: string,
	cwd: string,
	file: string,
	projectKey?: string | null,
): string {
	return path.join(sharpshooterBankDir(agentDir, cwd, projectKey), file);
}

/** Advisory lock path guarding consolidation for a bank. */
// withFileLock appends ".lock" itself, so this is the bare stem.
export function sharpshooterLockPath(agentDir: string, cwd: string, projectKey?: string | null): string {
	return path.join(sharpshooterBankDir(agentDir, cwd, projectKey), "consolidate");
}

/** Read a bank's consolidation state; a missing or corrupt file yields the epoch state. */
export async function readSharpshooterState(
	agentDir: string,
	cwd: string,
	projectKey?: string | null,
): Promise<SharpshooterState> {
	try {
		const parsed = (await Bun.file(
			path.join(sharpshooterBankDir(agentDir, cwd, projectKey), "state.json"),
		).json()) as SharpshooterState;
		if (parsed && typeof parsed === "object" && parsed.v === 1) return parsed;
	} catch {
		// Missing or corrupt state only delays the next consolidation window; start fresh.
	}
	return { v: 1, lastConsolidatedAt: 0 };
}

/** Persist a bank's consolidation state (parent directories auto-created). */
export async function writeSharpshooterState(
	agentDir: string,
	cwd: string,
	state: SharpshooterState,
	projectKey?: string | null,
): Promise<void> {
	await Bun.write(
		path.join(sharpshooterBankDir(agentDir, cwd, projectKey), "state.json"),
		`${JSON.stringify(state, null, "\t")}\n`,
	);
}
