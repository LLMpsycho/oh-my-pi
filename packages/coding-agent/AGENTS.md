# Coding Agent (`omp` CLI)

**Generated:** 2026-06-27 22:59:25
**Commit:** 734becaae
**Branch:** main

## OVERVIEW

Primary CLI application (`omp`). Agent session orchestration, tool dispatch, MCP protocol, TUI, LSP integration, provider discovery, extensibility. ~1002 src files across 50 subdirs.

## STRUCTURE

```
packages/coding-agent/
├── src/
│   ├── cli/              # CLI command handlers (37 files)
│   ├── commands/         # User-facing slash-commands (32 files)
│   ├── config/           # Settings schema (5024 lines) + prompt templates
│   ├── modes/            # UI mode components (22 dirs, 73+ files)
│   ├── session/          # Agent session management (35 files, 14K lines)
│   ├── tools/            # Tool implementations (71 files)
│   ├── tools/gh.ts       # GitHub tool (3752 lines)
│   ├── prompts/          # System prompts (53 files) + tool prompts (41 files)
│   ├── mcp/              # MCP protocol support
│   ├── lsp/              # Language server protocol (1292-line LspTool)
│   ├── web/              # Web search/scrapers (78 scrapers)
│   ├── extensibility/    # Plugin/extension system
│   ├── discovery/        # Provider discovery + builtin TTSR rules
│   ├── edit/             # Apply-patch edit tool
│   ├── task/             # Sub-agent/task dispatch
│   ├── eval/             # Session evaluation (js, rb, jl, tsx runners)
│   ├── cli.ts            # CLI entry point (worker-host dispatch)
│   └── main.ts           # Session bootstrap entry
└── test/                 # 434 test files, CI-split into 4 buckets
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a new tool | `src/tools/` + `src/prompts/tools/` |
| Add a command | `src/commands/` + `src/prompts/system/` |
| Modify TUI rendering | `src/modes/` (interactive, non-interactive, theme) |
| Modify settings | `src/config/settings-schema.ts` |
| Add LSP support | `src/lsp/` |
| Add MCP server | `src/mcp/` |
| Add web scraper | `src/web/scrapers/` |
| Add extension/plugin | `src/extensibility/` + `src/discovery/` |
| Modify session logic | `src/session/` — agent-session.ts is 14K lines |
| Modify edit tooling | `src/edit/` + `src/edit/apply-patch/` |
| Add TTSR rule | `src/discovery/builtin-rules/` (markdown files) |
| Test agent behavior | `test/session/`, `test/tools/`, `test/core/` |

## KEY FILES

| File | Lines | Role |
|------|-------|------|
| `src/cli.ts` | — | CLI entry + worker-host dispatch |
| `src/main.ts` | — | Session bootstrap, arg parsing, config |
| `src/session/agent-session.ts` | 14K | Core agent loop — largest hand-written file |
| `src/config/settings-schema.ts` | 5K | All user-facing settings |
| `src/tools/gh.ts` | 3.8K | GitHub integration tool |
| `src/modes/interactive-mode.ts` | 4.1K | Interactive TUI mode |
| `src/lsp/index.ts` | 1.3K | LspTool class |

## CONVENTIONS (beyond root)

- **Tests**: `bun test` via `ci-test-ts.ts` orchestrator (4 buckets: singleton, ui, runtime, native). No direct `bun test` — always use the CI splitter.
- **Build**: `bun run build` → `scripts/build-binary.ts`. For npm: `prepack` runs `gen:docs`, `gen:tool-views`, `gen:bundle`.
- **Prompts**: `src/prompts/system/` and `src/prompts/tools/`. Format with `bun run format-prompts`.
- **Tool views**: generated from collab-web via `gen:tool-views`.
- **Bench guard**: `scripts/bench-guard.ts` enforces boot-time perf baseline.
- **Docs index**: managed via `gen:docs` / `gen:docs:reset` scripts.
- **Native embedding**: mupdf WASM via `gen:mupdf`/`gen:mupdf:reset`.
- **Worker contract**: see root CLAUDE.md "Worker scripts" section — all workers dispatch through `cli.ts`.

## COMMANDS

```
bun run build          # compile standalone binary
bun run test           # run CI-split test suite (4 buckets)
bun run check          # biome lint + tsgo typecheck
bun run fix            # biome auto-fix + format-prompts
bun run format-prompts # format system/tool prompt markdown
bun run bench:guard    # boot-time perf baseline check
bun run gen:docs       # generate docs index
bun run gen:tool-views # generate tool views for TUI
bun run gen:mupdf      # embed mupdf WASM
bun run gen:bundle     # bundle for npm distribution
```
