/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { Effort } from "@oh-my-pi/pi-ai";
import { parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { parseAgentFields } from "../discovery/helpers";
// Embed agent markdown files at build time
import apiDesignerMd from "../prompts/agents/api-designer.md" with { type: "text" };
import backendMd from "../prompts/agents/backend.md" with { type: "text" };
import debugMd from "../prompts/agents/debug.md" with { type: "text" };
import designerMd from "../prompts/agents/designer.md" with { type: "text" };
import devopsMd from "../prompts/agents/devops.md" with { type: "text" };
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import librarianMd from "../prompts/agents/librarian.md" with { type: "text" };
import metisMd from "../prompts/agents/metis.md" with { type: "text" };
import migratorMd from "../prompts/agents/migrator.md" with { type: "text" };
import momusMd from "../prompts/agents/momus.md" with { type: "text" };
import oracleMd from "../prompts/agents/oracle.md" with { type: "text" };
import performanceMd from "../prompts/agents/performance.md" with { type: "text" };
import prometheusMd from "../prompts/agents/prometheus.md" with { type: "text" };
import reviewerMd from "../prompts/agents/reviewer.md" with { type: "text" };
import scoutMd from "../prompts/agents/scout.md" with { type: "text" };
import sentinelMd from "../prompts/agents/sentinel.md" with { type: "text" };
import taskMd from "../prompts/agents/task.md" with { type: "text" };
import tddReviewerMd from "../prompts/agents/tdd-reviewer.md" with { type: "text" };
import { AUTO_THINKING } from "../thinking";

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
	prewalk?: boolean | string;
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = prompt.render(def.template);
	if (!def.frontmatter) return body;
	return prompt.render(agentFrontmatterTemplate, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "scout.md", template: scoutMd },
	{ fileName: "designer.md", template: designerMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{ fileName: "librarian.md", template: librarianMd },
	{ fileName: "api-designer.md", template: apiDesignerMd },
	{ fileName: "backend.md", template: backendMd },
	{ fileName: "debug.md", template: debugMd },
	{ fileName: "devops.md", template: devopsMd },
	{ fileName: "metis.md", template: metisMd },
	{ fileName: "migrator.md", template: migratorMd },
	{ fileName: "momus.md", template: momusMd },
	{ fileName: "oracle.md", template: oracleMd },
	{ fileName: "performance.md", template: performanceMd },
	{ fileName: "prometheus.md", template: prometheusMd },
	{ fileName: "sentinel.md", template: sentinelMd },
	{ fileName: "tdd-reviewer.md", template: tddReviewerMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "*",
			model: "@task",
			thinkingLevel: AUTO_THINKING,
			// No `prewalk` frontmatter: the generic task hand-off (strong model
			// plans, then hands off to the smol role) is armed by the
			// `task.prewalk` setting (default off) or per agent via /agents
			// (task.agentPrewalk).
		},
		template: taskMd,
	},
	{
		fileName: "sonic.md",
		frontmatter: {
			name: "sonic",
			description: "Low-reasoning agent for strictly mechanical updates or data collection only",
			model: "@smol",
			thinkingLevel: Effort.Medium,
		},
		template: taskMd,
	},
];

// Computed lazily on first loadBundledAgents() call to avoid eager prompt.render at module load.

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/**
 * Parse an agent from embedded content.
 */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}
	bundledAgentsCache = EMBEDDED_AGENT_DEFS.map(def =>
		parseAgent(`embedded:${def.fileName}`, buildAgentContent(def), "bundled"),
	);
	return bundledAgentsCache;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find(a => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
 */
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
