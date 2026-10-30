# FAQ

**Does CircuitPilot upload my board to the cloud?**
No by default. The Runtime binds to loopback. AI providers receive only the
text you explicitly send in a request; API keys stay in Keychain.

**Why does `/api/health` work but other API calls return 401?**
The desktop shell issues a per-launch token to the WebView and the Runtime.
External processes without that token are rejected by design.

**Can it place a PCB order for me?**
No. Ordering and payment are permanently manual. The software may prepare
checks and evidence, but never submits an order.

**Why is the release gate blocked?**
Because required evidence is missing, stale, or mismatched. That is the
intended fail-closed behaviour. See
[validation-and-release.md](guides/validation-and-release.md).

**Where are my projects and evidence stored?**
By default under
`~/Library/Application Support/com.circuitpilot.desktop/state`.

**Does it work on Windows/Linux?**
The current target is macOS. The web console can run in a browser for
development, but the desktop shell is macOS-first.

**Can I redistribute a packaged build?**
Only if you comply with Apache-2.0, include NOTICE/third-party licenses, and
handle Apple signing/notarization yourself. The repository does not grant
rights to vendor software.
