## ADDED Requirements

### Requirement: Validation dashboard
The system SHALL present ERC, DRC, netlist, footprint, BOM, board geometry, 3D interference, and DFM checks with status, severity, count, and evidence.

#### Scenario: Run all validations
- **WHEN** the user selects run-all validation
- **THEN** the checks show progress and resolve to pass, warning, or failure with a refreshed summary

#### Scenario: Inspect a finding
- **WHEN** the user opens a validation finding
- **THEN** the system shows the affected object, rule, evidence, suggested action, and demo navigation control

### Requirement: Validation waivers
The system SHALL require a reason and confirmation before a warning or failure can be marked waived and SHALL preserve the original finding.

#### Scenario: Add a waiver
- **WHEN** the user enters a waiver reason and confirms
- **THEN** the finding remains visible with waived status, reason, actor, and timestamp

#### Scenario: Attempt waiver without reason
- **WHEN** the user submits an empty waiver
- **THEN** the system rejects it and requests a reason

### Requirement: Version and snapshot management
The system SHALL display snapshots and milestone versions, allow version detail inspection, and simulate creating, comparing, restoring, and labelling versions.

#### Scenario: Create a manual snapshot
- **WHEN** the user provides a snapshot label
- **THEN** the system adds a new version with current task and validation summary

#### Scenario: Compare versions
- **WHEN** the user chooses two versions
- **THEN** the system shows structured changes to requirements, BOM, design objects, and validation counts

#### Scenario: Roll back a version
- **WHEN** the user confirms rollback to an eligible snapshot
- **THEN** the system creates a new rollback event and updates the active demo version without deleting history

### Requirement: Audit log and demo deliverables
The system SHALL provide searchable audit events and SHALL generate clearly marked demo diagnostic or engineering-review downloads.

#### Scenario: Filter audit events
- **WHEN** the user filters by task, event type, status, or text
- **THEN** the audit table and result count update to the matching events

#### Scenario: Export a demo report
- **WHEN** the user confirms diagnostic or review-package export
- **THEN** the system downloads a file containing a demo warning, current summary, and non-sensitive event data

