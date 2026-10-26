# Development

## Commands

| Command | Purpose |
|---|---|
| `npm run dev:full` | Vite + Runtime together (recommended). |
| `npm run dev` | Vite only (port 4177). |
| `npm run dev:runtime` | Runtime only (port 4178). |
| `npm run typecheck` | TypeScript project build check. |
| `npm test` | typecheck + Vitest + Runtime tests. |
| `npm run test:runtime` | Node test runner suite for `runtime/`. |
| `npm run test:e2e` | Playwright end-to-end tests. |
| `npm run build` | Production web build. |
| `npm run desktop:dev` | Tauri development app. |
| `npm run desktop:app` | Build the macOS `.app`. |

## Layout

```
src/            React console
src-tauri/      Rust/Tauri shell
runtime/        Local HTTP Runtime and adapters
scripts/        Dev, verification, release helpers
e2e/            Playwright specs
runtime/__tests__/  Node unit/contract tests
docs/           Documentation
spec/ rules/ openspec/  Design contracts and rule data
```

## Conventions

- TypeScript strict mode; no `any` escape hatches without a comment.
- Runtime code is ESM (`.mjs`) and must not require network access in tests.
- Every write path needs a fail-closed test; every gate needs a negative test.
- UI text must remain readable: no text below 11px; focus states are required.
- Do not commit local state, evidence, keys, customer files, or build outputs.

## Environment variables

See [configuration.md](configuration.md) and `.env.example`.
