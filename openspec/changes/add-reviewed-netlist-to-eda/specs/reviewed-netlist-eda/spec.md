# Reviewed netlist to EDA

## ADDED Requirements

### Requirement: Generate a project-scoped reviewable netlist

The system SHALL generate a structured netlist draft only from the selected project's confirmed requirements, BOM, evidence and exact EasyEDA device bindings.

#### Scenario: Required connectivity is missing

- **WHEN** a device binding, reference designator, pin number or critical connection lacks evidence
- **THEN** the draft is blocked with focused questions
- **AND** no EDA preparation or execution action is enabled

#### Scenario: Netlist draft is reviewable

- **WHEN** all components and connections have evidence
- **THEN** the UI shows every component and every net endpoint for user review
- **AND** no EDA write occurs before explicit confirmation

### Requirement: Compile only confirmed connectivity

Runtime SHALL deterministically compile a user-confirmed netlist into registered schematic operations.

#### Scenario: Endpoint references an unknown component or pin

- **WHEN** an endpoint cannot be resolved to a confirmed component reference and explicit pin number
- **THEN** compilation is blocked
- **AND** the plan is not eligible for approval

#### Scenario: Confirmed netlist compiles

- **WHEN** every component has an exact EasyEDA identity and every net has at least two resolvable endpoints
- **THEN** Runtime emits only allowlisted component and connectivity operations
- **AND** binds the compiled result to a deterministic hash

### Requirement: Execute through existing EDA safety gates

The system SHALL require target binding, one-time approval, snapshot, readback, official DRC and rollback for the compiled schematic plan.

#### Scenario: Schematic execution succeeds

- **WHEN** the user gives final execution confirmation and all gates pass
- **THEN** the schematic is saved and read back
- **AND** official schematic DRC passes before PCB synchronization begins

#### Scenario: Any mutation or verification fails

- **WHEN** an operation, readback or DRC fails after mutation
- **THEN** remaining operations stop
- **AND** Runtime restores and verifies the pre-execution source snapshot

### Requirement: Synchronize successful schematic to PCB

The system SHALL synchronize to PCB only after a successful schematic execution and SHALL expose the resulting PCB evidence.

#### Scenario: PCB synchronization completes

- **WHEN** the confirmed schematic has passed readback and DRC
- **THEN** Runtime invokes the fixed PCB import/synchronization command
- **AND** the UI displays the refreshed component, net, line, via and pour counts
