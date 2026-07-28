import { defineConfig } from "react-doctor/api";

/**
 * React surfaces in this monorepo:
 * - packages/collab-web
 * - packages/stats (client dashboard)
 * - packages/metaharness (web dashboard)
 *
 * robomp/web is SolidJS, not React — intentionally omitted.
 */
export default defineConfig({
	projects: [
		"@oh-my-pi/collab-web",
		"@oh-my-pi/omp-stats",
		"@oh-my-pi/pi-metaharness",
	],
	ignore: {
		files: [
			"**/node_modules/**",
			"**/dist/**",
			"**/target/**",
			"**/*.generated.*",
			"packages/stats/src/embedded-client.ts",
			"packages/coding-agent/src/export/html/tool-views.generated.js",
		],
	},
	// Keep local/CI scans advisory until the baseline is cleaned up.
	blocking: "none",
	verbose: false,
	// Network Socket.dev scoring is noisy offline / in air-gapped CI clones.
	supplyChain: {
		enabled: true,
		includeDevDependencies: false,
		severity: "warning",
	},
});
