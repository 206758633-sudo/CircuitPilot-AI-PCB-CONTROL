# PCB production Runtime implementation record

## Delivered

- Runtime upgraded to 0.5.0 with fixed PCB read, navigation, synchronization, save, DRC, component, line, via, pour, 3D, BOM, CPL and Gerber metadata commands.
- Added a versioned PCB plan, deterministic CH32V003 45×30 mm compiler, stable plan hash, target-bound single-use approval, source snapshot, rollback verification and official PCB DRC gate.
- Added a truthful capability matrix. Official Beta APIs are never presented as production-ready; ordering and payment are permanently unavailable.
- Desktop EDA page now displays the live capability status and the reason for every manual-review gate.

## Live evidence

- Bridge: `127.0.0.1:49620`, one connected EDA window.
- Project: `CircuitPilot-CH32V003-P0` (`e4b90e4c...`).
- Schematic page: `098517457e41226c`; PCB: `de4911bced17666d`.
- Schematic evidence: 14 physical components, every physical component has a footprint and `addIntoPcb=true`; C49257 header footprint is present.
- PCB before synchronization: 0 nets, 0 components, 0 lines, 0 vias, 0 pours.
- `PCB_Document.importChanges()` returned `true` for both schematic and page UUID, but repeated PCB readback remained empty. This result is recorded as failed readback, not completion.
- Computer-use inspection became unavailable after the first screenshot, so the likely interactive import dialog could not be completed in this run.

## Verification

- TypeScript typecheck passed.
- Production build passed.
- 16 frontend tests and 26 Runtime tests passed, including unknown-command rejection and production-capability truthfulness.

## Successful-execution lessons

1. A successful API boolean is not evidence of a successful EDA mutation; object-count and source-digest readback are mandatory.
2. 嘉立创EDA V3.2.175 uses `pcb_PrimitiveString`, not `pcb_PrimitiveText`; capability probing must test each class independently.
3. Beta API labels from official documentation must propagate into Runtime schemas and UI so an experimental action can never appear production-approved.
4. PCB synchronization should be a separately reviewable stage because an interactive EDA dialog may outlive the API call.
