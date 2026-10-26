## 1. Contracts and read model

- [x] 1.1 Add versioned runtime schemas and shared frontend types for design context, simple-board plans, approvals, executions, snapshots, DRC results, and recovery states
- [x] 1.2 Extend the 嘉立创EDA fixed command registry with normalized project, document, schematic catalog, component/pin, wire, and net-flag reads
- [x] 1.3 Implement design-context collection, target fingerprinting, ambiguity checks, and target-drift detection with unit tests

## 2. Planning and approval

- [x] 2.1 Implement deterministic plan validation, stable serialization, SHA-256 hashing, and missing-information reporting for MCU, power, LED, and button plans
- [ ] 2.2 Connect the AI planning request to schema-constrained Codex/Claude output while preventing executable script output
- [x] 2.3 Implement short-lived single-use approval tokens bound to plan hash, target fingerprint, window, and approved steps, with tamper/expiry/replay tests

## 3. Controlled write and recovery

- [x] 3.1 Add strictly validated fixed commands for document source snapshot/restore, component creation, wire creation, net flags, save, readback, and schematic DRC
- [x] 3.2 Implement the serialized execution state machine with pre-write capability probe, snapshot hard gate, per-command audit events, save, readback comparison, and target checks
- [ ] 3.3 Implement snapshot restore, save, digest verification, rollback-failed lockout, and recovery tests for failures at each mutation stage

## 4. Runtime API and interface

- [x] 4.1 Add authenticated local Runtime endpoints for context refresh, plan generation, approval, execution status, cancellation-before-write, and recovery evidence
- [ ] 4.2 Update the AI page to complete missing engineering information and render the immutable structured plan and approval summary
- [ ] 4.3 Update the EDA page with selected-target evidence, capability probe, snapshot/write/readback/DRC/recovery stages, and explicit PCB out-of-scope status
- [x] 4.4 Connect execution events to the existing change log and error center without exposing secrets or raw document source

## 5. Verification and delivery

- [x] 5.1 Add runtime unit/integration tests for command validation, target drift, plan hashing, approval security, DRC result handling, and verified rollback
- [ ] 5.2 Add frontend reducer/component and Playwright coverage for blocked information, approval, execution progress, errors, and recovery states
- [x] 5.3 Run typecheck, frontend tests, runtime tests, build, and E2E suite and record the evidence
- [x] 5.4 On a user-confirmed dedicated blank 嘉立创EDA test project, perform capability probe and snapshot/restore rehearsal without retaining a design change
- [x] 5.5 After exact parts and target are confirmed, execute the MCU/power/LED/button schematic, verify readback and official schematic DRC, and record the end-to-end acceptance result
- [x] 5.6 Update README/operator documentation, task status, implementation record, limitations, and successful-execution lessons
