## ADDED Requirements

### Requirement: Project workspace management
The system SHALL allow the user to create, select, edit, archive, and restore demo projects while maintaining one active project.

#### Scenario: Create a project
- **WHEN** the user completes the new-project form with required values
- **THEN** the system adds the project, makes it active, persists it locally, and shows a success notification

#### Scenario: Archive the active project
- **WHEN** the user confirms project archival
- **THEN** the system marks the project archived without deleting its data and selects another available project or an empty state

### Requirement: Structured requirement management
The system SHALL present requirements by engineering category with value, unit, source, hard-or-soft classification, confirmation status, and conflict indicators.

#### Scenario: Edit a requirement
- **WHEN** the user changes a requirement value or status and saves it
- **THEN** the requirement list, completeness score, history indicator, and persistence state update

#### Scenario: Filter missing information
- **WHEN** the user selects the missing or conflict filter
- **THEN** only requirements matching that status are displayed with their blocking reason

#### Scenario: Confirm an AI suggestion
- **WHEN** the user explicitly confirms an AI-suggested requirement
- **THEN** the status changes to confirmed and the action is recorded as a user decision

### Requirement: File and evidence library
The system SHALL allow users to add demo file records, inspect metadata, choose an authoritative source, link evidence to requirements or components, and remove only records created inside the Demo.

#### Scenario: Add a file record
- **WHEN** the user selects files in the upload interaction
- **THEN** the system creates local demo records showing file type, size, version, status, and a simulated hash

#### Scenario: Mark authoritative evidence
- **WHEN** the user marks one document as the formal source
- **THEN** the document receives an authoritative indicator and related records display that source

### Requirement: BOM and component workspace
The system SHALL provide searchable, filterable BOM data with editable component details, alternate-part decisions, risk states, and a demo export.

#### Scenario: Search the BOM
- **WHEN** the user enters a reference designator, manufacturer part number, package, or LCSC identifier
- **THEN** the component table displays matching rows and updates the result count

#### Scenario: Approve an alternate part
- **WHEN** the user reviews and approves a proposed alternate
- **THEN** the component records the approval and the related open-risk count decreases

#### Scenario: Export the BOM
- **WHEN** the user confirms BOM export
- **THEN** the system downloads a clearly labelled demo CSV generated from the current local BOM state

