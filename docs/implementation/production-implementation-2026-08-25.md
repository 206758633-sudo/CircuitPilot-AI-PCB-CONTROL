# AI-PCBA production implementation record — 2026-08-25

## Implemented

- Added a versioned, evidence-constrained PCBA semantic-plan schema and a dedicated Codex structured-output route.
- Added deterministic compilation to allowlisted PCB primitives; model-generated scripts remain impossible.
- Added conservative JLC two-layer manufacturing rules, board/edge/collision checks, differential-pair stackup blocking, safety and thermal required-input gates.
- Added deterministic net-class routing, GND pour intent, quality metrics and mandatory human final review.
- Added per-stage PCB snapshots, batches of at most 50 operations, progress heartbeats, operation timeout, stage readback, verified rollback and write lockout.
- Added BOM/CPL/Gerber/drill/STEP discovery, SHA-256, BOM/CPL schema validation, reference-set checks, Gerber archive layer checks and immutable manifest hashing.
- Added official JLC DFM manual handoff. The system never converts local validation into an online-DFM pass and never enables ordering or payment.
- Added macOS Hardened Runtime and entitlements configuration plus a release preflight that blocks without Rust, Developer ID, Team ID and notarization credentials.

## Deliberately blocked

- Arbitrary-board placement optimization, multilayer via planning, high-speed return-path analysis and general silkscreen generation need additional specialized algorithms and physical evidence.
- Gerber API and auto-router remain non-production because the documented EasyEDA APIs are Beta/user-assisted.
- Online DFM upload, CAPTCHA/login and final order confirmation require the user's active account and approval.
- A signed/notarized macOS release requires Apple Developer credentials; the current machine also lacks Rust/Cargo.

## Verification

- TypeScript typecheck passed.
- Frontend unit tests passed: 16/16.
- Runtime tests passed: 36/36, including deterministic planning, missing evidence, impedance stackup gate, artifact hashing, manifest release boundary, partial mutation, timeout, DRC failure and rollback lockout.
- Playwright end-to-end tests passed: 13/13.
- Production build and OpenSpec strict validation passed.
- Live services passed: UI HTTP 200, Runtime healthy, EasyEDA Bridge connected with one active window, PCB context complete with zero read errors.
- Existing production package passed local content validation: 8 files, 14 BOM references, 12 SMT CPL references, immutable manifest hash `8795ffe06ae5739a3a3183ff85e5c4664f79511c39ecb9283af96b86e5e4fe03`.
- macOS release preflight correctly blocked: Cargo/Rust, Developer ID certificate, Apple Team ID and notarization credentials are absent; Hardened Runtime entitlements are present.

## Successful-execution lessons

- Progress metadata must not replace the raw official DRC payload; DRC parsing must explicitly unwrap the result.
- Stage rollback must bind the source and digest from the same stage snapshot.
- A production package is not ready merely because files exist: content fields, reference sets, layer/drill presence, design binding, online DFM and human review are separate gates.
