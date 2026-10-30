# Security model

## Trust boundaries

| Boundary | Rule |
|---|---|
| Console → Runtime | Loopback only; every request carries a per-launch token. |
| Runtime → EDA editor | Loopback CDP/WebSocket to a locally installed, user-controlled editor. |
| Runtime → AI provider | Only the prompt/context needed for the request; API keys stay in Keychain. |
| Repository → user data | The repo contains no user state, evidence, credentials, or board files. |

## Token handling

The desktop shell generates a random token at launch. It is delivered through
two channels that do not traverse HTTP: the sidecar process stdin and the
WebView initialization script. External processes that call
`http://127.0.0.1:4178/api/*` without the token receive `401`. This is
intentional; do not add an HTTP token bootstrap.

## Write safety

- Writes are disabled by default.
- A write requires: exact target identity, a complete plan, a plan hash
  approved by a human, and a successful source snapshot.
- After writing, the Runtime reads back primitives and runs the vendor
  ERC/DRC. Failures trigger a restore from the snapshot.
- The release gate is fail-closed. DRC/ERC, DFM, sign-off, and BOM/CPL
  evidence must exist and match; otherwise the gate reports blockers.

## Permanent non-goals

- No automatic ordering or payment.
- No fabricated DRC/ERC/DFM/sign-off results.
- No hidden network telemetry by default.

## Reporting

Please use GitHub Security Advisories, not public issues, for vulnerabilities.
See [SECURITY.md](../../SECURITY.md).
