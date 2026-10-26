# CircuitPilot — AI PCBA Control

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL/actions/workflows/ci.yml/badge.svg)](https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

CircuitPilot is a **local-first, human-in-the-loop desktop console for
AI-assisted PCBA work on macOS**. It connects a React control console, a
Tauri/Rust shell, and a local Node Runtime to a locally installed EDA editor
(嘉立创EDA / EasyEDA). It is intentionally conservative: every hardware write
requires an explicit plan, human approval, read-back, and vendor ERC/DRC;
missing evidence blocks a release instead of producing a fake pass.

> **Status:** experimental. Not production-ready for safety-critical,
> medical, automotive, or mission-critical hardware. It is not a substitute
> for an engineer's review, DFM sign-off, or your fabricator's checks.

## Why

Most "AI PCB" demos stop at generating text. CircuitPilot focuses on the hard
parts: exact target identity, approved plan hashes, controlled writes,
read-back, evidence capture, and a fail-closed release gate. When the software
cannot prove something, it says **unknown/blocked** — never "passed".

## Features

- Local-only Runtime on `127.0.0.1` with a per-launch token; no cloud backend.
- Project state, trace, issue ledger, and evidence stored locally.
- AI requirement chat with structured design facts and reviewable plans.
- Controlled EDA execution through the vendor editor's debugging interface.
- DRC/ERC evidence capture, pin/net audits, and release-gate reporting.
- Provider support: Codex CLI, Claude Code, OpenAI/Anthropic APIs, and
  custom OpenAI/Anthropic-compatible endpoints. Keys live in macOS Keychain.
- Bilingual UI (Simplified Chinese / English) with a dense "Clear Bench"
  engineering design system.
- Demo mode for UI walkthroughs; demo data is always labelled.

## Architecture

```mermaid
flowchart LR
  UI[React console<br/>src/] -->|loopback + token| RT[Local Node Runtime<br/>runtime/]
  RT -->|CDP / localhost| EDA[嘉立创EDA / EasyEDA]
  RT --> STATE[(State + evidence)]
  RT --> AI[AI provider]
  SHELL[Tauri shell<br/>src-tauri/] --> UI
  SHELL -->|spawn + stdin token| RT
```

See [docs/architecture/overview.md](docs/architecture/overview.md) and
[security model](docs/architecture/security-model.md).

**User manual (简体中文):** [操作指导说明书](docs/guides/user-manual.zh-CN.md) · [PDF](docs/guides/CircuitPilot-User-Manual-v0.2.0.zh-CN.pdf)

## Quick start

Requirements: macOS 12+, Node.js 22+, npm. For the desktop shell: Rust and
Xcode command line tools.

```bash
git clone https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL.git
cd CircuitPilot-AI-PCB-CONTROL
npm ci
npm run dev:full
```

- Console: <http://127.0.0.1:4177>
- Runtime health: <http://127.0.0.1:4178/api/health>

Desktop app (development):

```bash
npm run desktop:dev
```

Build a macOS bundle:

```bash
npm run desktop:app
# -> src-tauri/target/release/bundle/macos/CircuitPilot.app
```

## Configuration

Configure AI providers and EDA in the app's **Settings**. API keys are stored
in macOS Keychain. Development-only overrides are documented in
[docs/getting-started/configuration.md](docs/getting-started/configuration.md)
and [.env.example](.env.example). Never commit real keys.

## Safety boundaries

- The Runtime binds to loopback only and rejects requests without the
  per-launch token (`401` is expected for external processes).
- Hardware writes are disabled by default; they require exact target identity,
  a complete plan, human approval, a source snapshot, and read-back.
- After a write, the vendor ERC/DRC runs. Failure restores from the snapshot.
- The release gate is fail-closed: missing/stale/mismatched DRC, ERC, DFM,
  BOM/CPL, or sign-off evidence is reported as blocked.
- **No automatic ordering or payment.** No fabricated results.

## Repository layout

```
src/            React + TypeScript console
src-tauri/      Tauri 2 / Rust macOS shell
runtime/        Local Node Runtime, EDA bridge, evidence, gates
scripts/        Dev / verification / release helpers
e2e/            Playwright end-to-end tests
docs/           Architecture, setup, usage, design, limitations
spec/ rules/ openspec/   Design contracts and rule data
```

## Tests

```bash
npm run typecheck
npx vitest run
npm run test:runtime
npm run test:e2e     # needs Playwright browsers
npm run build
```

## Packaging and releases

Packaged `.app`/`.dmg` files are **not committed to git** (they are large
binaries and should not live in the source tree). Releases are published as
GitHub Release assets; the repository keeps the source, docs, and build
workflow. Builds are unsigned (ad-hoc) unless Developer ID signing and
notarization are configured — see
[docs/getting-started/macos-signing.md](docs/getting-started/macos-signing.md).

## Not included

To respect third-party rights and keep the repository focused on software,
this repository does **not** include: customer/board source files, reference
designs, Gerber/BOM/CPL/STEP outputs, internal evidence bundles, or the
private knowledge dataset. See [docs/pcb/limitations.md](docs/pcb/limitations.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: use GitHub Security
Advisories, not public issues.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party
components are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
Vendor names and trademarks belong to their owners; this project is not
affiliated with or endorsed by them.
