# Roadmap

CircuitPilot is an experimental, local-first control console for AI-assisted
PCBA work on macOS. The roadmap is intentionally conservative: evidence and
human approval before automation.

## Now (v0.2.x)

- Stabilize the React console and local Runtime protocol.
- Keep write operations behind explicit human approval, dry-run gates, and
  read-back verification.
- Improve DRC/ERC evidence capture and release-gate reporting.
- Documentation, onboarding, and a reproducible development environment.

## Next

- Provider management polish (keychain-backed keys, custom OpenAI/Anthropic
  compatible endpoints).
- Easier EDA bridge setup and health diagnostics.
- More offline tests for placement, routing, and evidence contracts.
- Packaged release automation (unsigned local builds first).

## Later / exploring

- Multi-board project workflows and reusable design templates.
- Optional shared knowledge packs (rules/failure cases) with clear provenance.
- Cross-platform evaluation (the current target is macOS).

## Explicit non-goals

- Automatic ordering, payment, or fabrication release without human sign-off.
- Fabricating evidence, DRC/ERC results, or "pass" states.
- Shipping hardware manufacturing files or third-party reference designs.
