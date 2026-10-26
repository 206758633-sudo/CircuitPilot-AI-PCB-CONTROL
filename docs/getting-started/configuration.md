# Configuration

Most configuration is done in **Settings** inside the app. The Runtime stores
non-sensitive settings in its state directory and API keys in macOS Keychain.

## AI providers

- Codex CLI (local login)
- Claude Code (local login)
- OpenAI / Anthropic official APIs
- Custom OpenAI-compatible or Anthropic-compatible endpoints (HTTPS, or HTTP
  on loopback)

Keys are written to Keychain, never to the repository or plaintext state.
`.env.example` documents optional development overrides only.

## Runtime environment variables (development)

| Variable | Default | Purpose |
|---|---|---|
| `CIRCUITPILOT_STATE_DIR` | app data dir or `artifacts/state` | State store |
| `CIRCUITPILOT_EVIDENCE_DIR` | `<state>/evidence` | Evidence files |
| `CIRCUITPILOT_GATE_DRY_RUN` | unset | Force gate dry-run |
| `CIRCUITPILOT_EDA_CDP_PORT` | `9222` | EDA remote-debugging port |
| `CIRCUITPILOT_BRIDGE_PORT` | `49620` | Base port for the auto-started local EDA bridge (probes 10 ports) |
| `VITE_RUNTIME_URL` | `http://127.0.0.1:4178` | Frontend runtime URL |

Advanced variables (timeouts, retention, evidence paths) are documented in
the source. Do not put secrets in environment files committed to git.

## Storage locations

- State: `~/Library/Application Support/com.circuitpilot.desktop/state`
- Logs: `~/Library/Logs/com.circuitpilot.desktop/runtime.log`
- Keychain service prefix: `com.circuitpilot.provider.*`
