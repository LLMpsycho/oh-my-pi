/** Default model selectors for bundled specialist agents. */
export const BUNDLED_AGENT_MODEL_ROLES: Readonly<Record<string, string>> = {
	"API-DESIGNER": "@plan",
	BACKEND: "@slow",
	DEBUG: "@slow",
	DEVOPS: "@slow",
	LIBRARIAN: "@smol",
	METIS: "@plan",
	MIGRATOR: "@task",
	MOMUS: "@slow",
	ORACLE: "openai-codex/gpt-5.5",
	PERFORMANCE: "@slow",
	PROMETHEUS: "@plan",
	SENTINEL: "@slow",
	"TDD-REVIEWER": "@slow",
};

export const BUNDLED_AGENT_ROLE_IDS = Object.keys(BUNDLED_AGENT_MODEL_ROLES);
