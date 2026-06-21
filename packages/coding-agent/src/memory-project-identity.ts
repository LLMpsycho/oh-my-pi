import * as fs from "node:fs";
import * as path from "node:path";
import * as git from "./utils/git";

export type MemoryProjectIdentitySource = "explicit" | "git-remote" | "git-common-dir" | "cwd";

export interface MemoryProjectIdentity {
	key: string;
	segment: string;
	source: MemoryProjectIdentitySource;
}

interface RemoteConfigEntry {
	name: string;
	url: string;
}

const DEFAULT_PROJECT_KEY = "unknown";
const GIT_SUFFIX = /\.git$/i;
const REMOTE_SECTION = /^\s*\[remote\s+"([^"]+)"\]\s*$/;
const SECTION_HEADER = /^\s*\[/;
const URL_ENTRY = /^\s*url\s*=\s*(.*?)\s*$/;
const SCP_LIKE_REMOTE = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function resolveConfiguredMemoryProjectKey(
	configuredProjectKey: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const ompProjectKey = normalizeConfiguredProjectKey(env.OMP_PROJECT_KEY);
	if (ompProjectKey) return ompProjectKey;
	const hindsightProjectKey = normalizeConfiguredProjectKey(env.HINDSIGHT_PROJECT_KEY);
	return hindsightProjectKey ?? normalizeConfiguredProjectKey(configuredProjectKey) ?? null;
}

export function resolveMemoryProjectIdentity(cwd: string, configuredProjectKey?: string | null): MemoryProjectIdentity {
	const explicitKey = normalizeExplicitProjectKey(configuredProjectKey);
	if (explicitKey) return toIdentity(explicitKey, "explicit");

	const repository = cwd ? git.repo.resolveSync(cwd) : null;
	if (repository) {
		const remoteKey = resolveRemoteProjectKey(repository.commonDir);
		if (remoteKey) return toIdentity(remoteKey, "git-remote");
		return toIdentity(resolveLocalGitKey(repository), "git-common-dir");
	}

	if (!cwd) return toIdentity(DEFAULT_PROJECT_KEY, "cwd");
	return toIdentity(resolveLocalCwdKey(cwd), "cwd");
}

function normalizeConfiguredProjectKey(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function toIdentity(key: string, source: MemoryProjectIdentitySource): MemoryProjectIdentity {
	return {
		key,
		segment: projectSegment(key),
		source,
	};
}

function resolveRemoteProjectKey(commonDir: string): string | undefined {
	const remotes = readRemoteConfig(path.join(commonDir, "config"));
	const upstreamKey = pickRemoteKey(remotes, "upstream");
	if (upstreamKey) return upstreamKey;
	const originKey = pickRemoteKey(remotes, "origin");
	return originKey ?? pickFirstRemoteKey(remotes);
}

function readRemoteConfig(configPath: string): RemoteConfigEntry[] {
	let text: string;
	try {
		text = fs.readFileSync(configPath, "utf8");
	} catch {
		return [];
	}

	const remotes: RemoteConfigEntry[] = [];
	let currentRemote: string | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const section = REMOTE_SECTION.exec(rawLine);
		if (section) {
			currentRemote = section[1];
			continue;
		}
		if (SECTION_HEADER.test(rawLine)) {
			currentRemote = undefined;
			continue;
		}
		if (!currentRemote) continue;
		const url = URL_ENTRY.exec(rawLine);
		if (!url) continue;
		const value = url[1]?.trim();
		if (value) remotes.push({ name: currentRemote, url: value });
	}
	return remotes;
}

function pickRemoteKey(remotes: readonly RemoteConfigEntry[], name: string): string | undefined {
	for (const remote of remotes) {
		if (remote.name !== name) continue;
		const key = normalizeRemoteProjectKey(remote.url);
		if (key) return key;
	}
	return undefined;
}

function pickFirstRemoteKey(remotes: readonly RemoteConfigEntry[]): string | undefined {
	for (const remote of remotes) {
		const key = normalizeRemoteProjectKey(remote.url);
		if (key) return key;
	}
	return undefined;
}

function normalizeExplicitProjectKey(value: string | null | undefined): string | undefined {
	const trimmed = normalizeConfiguredProjectKey(value);
	if (!trimmed) return undefined;
	return normalizeRemoteProjectKey(trimmed) ?? normalizePlainProjectKey(trimmed) ?? normalizeFallbackKey(trimmed);
}

function normalizeRemoteProjectKey(value: string): string | undefined {
	const trimmed = value.trim();
	const urlKey = normalizeUrlProjectKey(trimmed);
	if (urlKey) return urlKey;
	if (URL_SCHEME.test(trimmed)) return undefined;
	return normalizeScpLikeProjectKey(trimmed);
}

function normalizeScpLikeProjectKey(value: string): string | undefined {
	const scpLike = SCP_LIKE_REMOTE.exec(value);
	if (!scpLike) return undefined;
	return normalizeHostPath(scpLike[1] ?? "", scpLike[2] ?? "");
}

function normalizePlainProjectKey(value: string): string | undefined {
	const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
	const parts = trimmed.split("/").filter(Boolean);
	if (parts.length < 3) return undefined;
	return normalizeHostPath(parts[0] ?? "", parts.slice(1).join("/"));
}

function normalizeUrlProjectKey(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (!isRemoteUrlProtocol(url.protocol) || !url.hostname) return undefined;
	return normalizeHostPath(url.hostname, url.pathname);
}

function isRemoteUrlProtocol(protocol: string): boolean {
	switch (protocol) {
		case "http:":
		case "https:":
		case "ssh:":
		case "git:":
		case "git+ssh:":
			return true;
		default:
			return false;
	}
}

function normalizeHostPath(host: string, rawPath: string): string | undefined {
	const normalizedHost = host.trim().toLowerCase();
	if (!normalizedHost) return undefined;
	const parts = rawPath
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	if (parts.length < 2) return undefined;
	const lastIndex = parts.length - 1;
	const repoName = (parts[lastIndex] ?? "").replace(GIT_SUFFIX, "");
	if (!repoName) return undefined;
	parts[lastIndex] = repoName;
	return `${normalizedHost}/${parts.join("/")}`.toLowerCase();
}

function canonicalPath(filePath: string): string {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function resolveLocalGitKey(repository: git.GitRepository): string {
	const commonDir = canonicalPath(repository.commonDir);
	const primaryRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
	const name = normalizeFallbackKey(path.basename(primaryRoot));
	return `local/${name}/${stablePathHash(commonDir)}`;
}

function resolveLocalCwdKey(cwd: string): string {
	const resolvedCwd = canonicalPath(cwd);
	const name = normalizeFallbackKey(path.basename(resolvedCwd));
	return `cwd/${name}/${stablePathHash(resolvedCwd)}`;
}

function stablePathHash(value: string): string {
	return Bun.hash(value).toString(36).replace(/^-/, "n").toLowerCase();
}

function normalizeFallbackKey(value: string): string {
	const normalized = value.trim().replace(GIT_SUFFIX, "").toLowerCase();
	return normalized || DEFAULT_PROJECT_KEY;
}

function projectSegment(key: string): string {
	const base = key
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${base || DEFAULT_PROJECT_KEY}-${stablePathHash(key)}`;
}
