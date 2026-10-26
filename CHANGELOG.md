# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
Semantic Versioning.

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
