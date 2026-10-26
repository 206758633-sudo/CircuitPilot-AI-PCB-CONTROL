# Architecture overview

CircuitPilot is a local-first desktop application. It does not run a cloud
backend and does not send board files anywhere by default.

```
┌─────────────────────────────────────────────────────────────┐
│ Tauri desktop shell (Rust)                                   │
│  · starts the Node Runtime sidecar                           │
│  · pipes a per-launch token to the Runtime (stdin)           │
│  · injects the same token into the WebView                   │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ React console (src/)                                  │   │
│  │  · project state, design chat, EDA execution,         │   │
│  │    validation, release gate, knowledge                │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────┘
                               │ loopback HTTP + token
┌──────────────────────────────▼──────────────────────────────┐
│ Local Node Runtime (runtime/)                               │
│  · state store / evidence store / approval ledger           │
│  · release gate and policy checks                           │
│  · EDA bridge (CDP) and API adapters                        │
│  · provider adapters (Codex CLI, Anthropic/OpenAI APIs)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ localhost only
                     ┌─────────▼─────────┐
                     │ 嘉立创EDA / EasyEDA│
                     │ (vendor desktop app)│
                     └───────────────────┘
```

## Components

| Component | Location | Responsibility |
|---|---|---|
| Console | `src/` | React + TypeScript UI. Never talks to the EDA editor directly; all actions go through the Runtime. |
| Desktop shell | `src-tauri/` | Tauri 2 app, window, sidecar lifecycle, per-launch token, state/log paths. |
| Runtime | `runtime/` | HTTP API on `127.0.0.1`, state/evidence persistence, policy and gate evaluation, EDA adapters. |
| Scripts | `scripts/` | Development, verification, and release helpers. |
| Tests | `runtime/__tests__/`, `e2e/`, `src/**/*.test` | Unit, contract, and browser-level checks. |
| Specs | `spec/`, `rules/`, `openspec/` | Design contracts and rule definitions. |

## Data flow (write path)

1. The user describes a requirement in the console.
2. The Runtime builds a **plan** (semantic plan + expected operations).
3. The plan hash is shown to the human. A write is rejected unless the plan
   matches the real target and the required approvals are present.
4. The Runtime performs the write through the EDA bridge, then **reads back**
   the affected primitives.
5. Schematic ERC / PCB DRC is executed. A failure restores from the source
   snapshot and is reported as a failure — never as a pass.
6. Evidence is written to the evidence directory; the release gate consumes
   that evidence. Missing evidence blocks; it does not silently pass.

## Persistence

- Application state: Tauri app data dir, `state/` (JSON stores).
- Evidence: `state/evidence/` (reports, snapshots, checksums).
- Provider keys: macOS Keychain, never plaintext in state or repo.
- Runtime logs: app log dir (`runtime.log`), with rotation.

All paths are configurable for development; see
[configuration](../getting-started/configuration.md).
