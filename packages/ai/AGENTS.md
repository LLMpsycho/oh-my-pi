# AI (`@oh-my-pi/pi-ai`)

**Generated:** 2026-06-27 22:59:25
**Commit:** 734becaae
**Branch:** main

## OVERVIEW

Multi-provider LLM client library. Streaming, auth, dialect mapping, provider registry, usage tracking. 256 src files across 8 subdirs.

## STRUCTURE

```
packages/ai/src/
├── providers/          # LLM provider implementations (45 files)
│   ├── anthropic.ts    # Anthropic (3860 lines)
│   ├── openai-responses-wire.ts  # OpenAI wire format (6391 lines)
│   ├── openai-codex-responses.ts # OpenAI Codex (3455 lines)
│   ├── google/         # Gemini + Vertex
│   ├── ollama.ts       # Local models
│   ├── gitlab-duo/     # GitLab Duo workflow
│   ├── devin/          # Devin provider (generated proto)
│   └── cursor/         # Cursor provider (generated proto)
├── registry/           # Provider registration + OAuth
├── dialect/            # Model dialect mapping (35 files)
├── auth-storage.ts     # Auth credential storage (5571 lines)
└── index.ts            # Barrel — re-exports types only
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a new provider | `src/providers/` + `src/registry/` |
| Modify streaming | `src/providers/<vendor>.ts` — check stream chunk format |
| Update auth flow | `src/auth-storage.ts` (5.6K lines) |
| Add OAuth provider | `src/registry/oauth/` |
| Map model → provider | `src/dialect/` |
| Update provider fetch logic | `src/registry/` — handles capability-based resolution |
| Test a provider | `test/` — 252 test files |

## CONVENTIONS

- **Providers implement**: streaming, non-streaming, tool use, thinking config. Each provider is self-contained in its file.
- **Wire formats**: OpenAI-responses-wire.ts (6.4K lines) defines the canonical wire format. Other providers map to it.
- **Auth**: multi-backend auth storage. See `auth-storage.ts` for credential caching.
- **Catalog values**: never import from `@oh-my-pi/pi-ai` — import from `@oh-my-pi/pi-catalog/<module>`. The ai barrel exports only types used by its own signatures (`Model`, `Api`, `ThinkingConfig`, `Effort`).
- **Generated protos**: `devin/` and `cursor/` providers include generated protobuf files (10K+ lines each). Do not edit by hand.
- **Testing**: 252 test files. Use `bun test --parallel`. Live-fire tests use `firepass.live.ts`.

## COMMANDS

```
bun run test      # bun test --parallel
bun run check     # biome + tsgo typecheck
bun run lint      # biome lint
bun run fix       # biome --write --unsafe
```
