# Validation and release

CircuitPilot distinguishes three different things:

| Concept | Meaning |
|---|---|
| Check result | A concrete DRC/ERC/DFM result from a real tool or human. |
| Evidence | A persisted artifact (report, snapshot, hash) proving the result. |
| Release gate | A policy decision over evidence. It is fail-closed. |

## Evidence requirements

- Schematic ERC: errors/warnings, with document identity.
- PCB DRC: report file, counts, and the target PCB identity.
- Pin/net audit: unknown nets and dangling pins must be explained.
- Manufacturing package: BOM, CPL, Gerber, drill, STEP, with content checks.
- DFM: online check performed by the user on the fabricator portal.
- Final sign-off: human reviewer bound to a manifest hash.

## What "blocked" means

A blocked gate is a normal, honest state. Typical blockers:

- missing or stale evidence,
- a DRC/ERC report that does not match the current board identity,
- BOM/CPL designator mismatch,
- unconfirmed placement,
- missing DFM or sign-off,
- a request made in demo mode.

## What the software never does

- It does not fabricate a pass.
- It does not upload files to a fabricator or place an order.
- It does not treat an aggregate count as a per-item repair plan.
- It does not silently downgrade an error to a warning.
