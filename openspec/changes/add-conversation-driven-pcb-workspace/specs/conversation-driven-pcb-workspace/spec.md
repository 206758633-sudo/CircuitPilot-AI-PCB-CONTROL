# Conversation-driven PCB workspace

## ADDED Requirements

### Requirement: Provide explicit new-design and existing-design entry paths

The EDA workspace SHALL provide separate actions for creating a new EasyEDA design and reading the currently open EasyEDA design.

#### Scenario: Create a new PCB design

- **WHEN** the user confirms the new-design action
- **THEN** Runtime opens the fixed supported EasyEDA application
- **AND** creates a project, board, schematic, schematic page and PCB through a registered command
- **AND** reads the created PCB context into the preview

#### Scenario: Read an existing PCB design

- **WHEN** the user chooses to read the current EasyEDA design
- **THEN** the application uses the fixed read-only PCB context endpoint
- **AND** displays synchronization status and bounded component, line, via and pour counts

### Requirement: Convert conversation into a reviewable controlled plan

The EDA workspace SHALL use current project requirements, assets and BOM to request a structured plan or explicit blockers.

#### Scenario: Evidence is incomplete

- **WHEN** required design evidence is missing
- **THEN** the AI candidate is blocked and asks focused questions
- **AND** no write is performed

#### Scenario: User prepares a ready candidate

- **WHEN** the user explicitly confirms a ready candidate
- **THEN** it enters the deterministic validation and approval pipeline
- **AND** no EasyEDA write occurs until the user starts execution and passes final confirmation

### Requirement: Preserve controlled write safety gates

Real PCB writes SHALL remain bound to the current target, one-time approval, snapshot, readback, DRC and rollback handling.

#### Scenario: Start EDA execution

- **WHEN** the target and plan are ready and the user confirms execution
- **THEN** Runtime executes the bound plan and reports readback and DRC evidence
- **AND** a failed mutation attempts snapshot restoration
