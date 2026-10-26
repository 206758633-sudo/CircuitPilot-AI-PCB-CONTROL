# Design

## State model

`ReviewedNetlist` contains project ID, components and nets. Every component binds a project BOM row to an exact EasyEDA device identity (`libraryUuid`, `uuid`) and an explicit schematic placement. Every endpoint uses a component reference and pin number. AI output is always a draft and never a write instruction.

## Validation and compilation

Runtime normalizes bounded input and rejects duplicate references, missing library identities, unknown endpoint references, empty pin numbers, nets with fewer than two endpoints and unconfirmed critical power nets. A valid netlist compiles deterministically into the existing allowlisted schematic plan. Component creation occurs first; connection operations resolve the created primitive and pin coordinates through fixed readback before creating wires.

## Execution boundary

The user must separately confirm the review draft and the final EDA execution. Execution binds plan hash, EDA window and document fingerprint, snapshots source, performs allowlisted operations, saves, reads back created primitives and connectivity, runs official schematic DRC and restores on failure. PCB import/synchronization only starts after the schematic execution succeeds.
