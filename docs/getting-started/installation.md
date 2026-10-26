# Installation

## Requirements

- macOS 12 or newer (the desktop build is macOS-first; Linux/Windows are not
  currently supported targets).
- Node.js 22+ and npm.
- For the desktop shell: Rust toolchain (`rustc`, `cargo`) and Xcode command
  line tools.
- Optional: a locally installed 嘉立创EDA Professional or EasyEDA instance for
  real hardware actions.

## Run the web console (fastest)

```bash
git clone https://github.com/206758633-sudo/CircuitPilot-AI-PCB-CONTROL.git
cd CircuitPilot-AI-PCB-CONTROL
npm ci
npm run dev:full
```

- Console: <http://127.0.0.1:4177>
- Runtime health: <http://127.0.0.1:4178/api/health>

`dev:full` starts Vite and the local Runtime together and stops both on exit.

## Run the desktop app (development)

```bash
npm run desktop:dev
```

This stages the Node sidecar, starts Vite + Runtime, and launches the Tauri
shell. The first Rust build can take several minutes.

## Build the macOS app

```bash
npm run desktop:app
```

The bundle is written to
`src-tauri/target/release/bundle/macos/CircuitPilot.app`. Builds are ad-hoc
signed by default; see [macos-signing.md](macos-signing.md) before distributing.

## Demo mode

If no AI provider or EDA editor is available, the console can be used in
explicit demo mode. Demo data is labelled and must not be treated as
validation or release evidence.
