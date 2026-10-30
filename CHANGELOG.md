# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
Semantic Versioning.

## [0.2.1] — 2026-10-26

### Added

- **One-click EDA launch**: the EDA 执行 page can start 嘉立创EDA Professional
  with the required CDP debug port (`9222`) instead of asking users to run a
  terminal command.
- The local Runtime now **auto-starts the EDA bridge daemon** on
  `127.0.0.1:49620–49629`, with a per-launch token and clean shutdown.
- Vendored the minimal `ws` server used by the bridge and added its MIT notice.

### Changed

- EDA setup documentation now states the required official
  **`run-api-gateway` (API Gateway)** extension and its external-interaction
  permission; the bridge daemon itself no longer needs to be started manually.
- Chinese operation manual updated for the one-click launch and automatic
  bridge, and regenerated as v0.2.1.
- Bridge port base can be overridden with `CIRCUITPILOT_BRIDGE_PORT` (used for
  isolated tests).

### Security

- The bridge still binds loopback only; the token is passed to the bridge child
  via environment and sent on every bridge request. Do not expose the port.

## [0.2.0] — 2026-10-26

### Added

- Initial public source release of the CircuitPilot desktop console
  (React + Tauri + local Node Runtime).
- Bilingual README (English / 简体中文), contribution guide, security policy,
  code of conduct, support guide, roadmap, and third-party notices.
- GitHub issue/PR templates, CodeQL/dependency automation hooks, and a
  macOS release workflow scaffold.

### Changed

- Repository prepared for open source: local evidence, customer/test-board
  files, manufacturing outputs, and machine-generated artifacts are excluded.
- Internal scripts and tests that depended on non-published datasets or a
  specific test board were removed or generalized.
- Tauri bundle resources now include only the local Runtime; fabrication
  outputs are not packaged.

### Security

- No API keys are stored in the repository; provider credentials are handled
  by macOS Keychain through the Runtime.
- The release gate remains fail-closed: missing DRC/ERC/DFM/sign-off evidence
  is reported as blocked, never as passed.

### Known limitations

- macOS 12+ only; packaged builds are unsigned (ad-hoc) unless you configure
  Developer ID signing and notarization.
- Hardware actions require a locally installed, logged-in EDA editor and the
  CDP bridge; they are not available in demo mode.
- The internal knowledge dataset and manufacturing examples are not shipped.
