# Capabilities and limitations

## What CircuitPilot does

- Local console for AI-assisted PCBA requirements and design planning.
- Controlled schematic/PCB operations through a vendor EDA editor, with
  human approval and read-back.
- Evidence collection for ERC/DRC, pin/net audits, and release gates.
- BOM/CPL/Gerber/STEP inspection when the user supplies manufacturing files.

## What it does not do

- It is **not** a replacement for a hardware engineer's review or sign-off.
- It does not guarantee a manufacturable board; DRC/ERC pass is not DFM
  approval, and DFM remains a human online check.
- It does not include fabrication outputs, customer files, or reference
  designs in this repository.
- It does not fabricate results or auto-release boards.
- It is not validated for safety-critical, medical, automotive, or
  mission-critical designs.

## EDA/API reality

Vendor APIs expose aggregate counts, DOM-only dialogs, and version-specific
behaviour. CircuitPilot therefore records what it can prove and reports the
rest as unknown/blocked. If a result cannot be obtained, the correct output
is "unknown", not "pass".

## Platform

- macOS 12+ only.
- Packaged builds are unsigned (ad-hoc) unless you configure Developer ID
  signing + notarization.
- Hardware actions require the vendor editor to be open and logged in.
