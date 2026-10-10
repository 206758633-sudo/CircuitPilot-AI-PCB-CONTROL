## ADDED Requirements

### Requirement: Generate a reviewable BOM draft from project evidence

The system SHALL let AI chat generate a structured BOM draft from the selected project's confirmed requirements, evidence metadata, existing BOM and read-only EDA evidence.

#### Scenario: Critical information is missing
- **WHEN** missing information can materially change component safety or identity
- **THEN** the draft is blocked and lists focused questions
- **AND** no BOM confirmation action is available

#### Scenario: Draft is reviewable
- **WHEN** sufficient evidence exists
- **THEN** the draft lists reference designators, quantities, values, proposed part identities, packages, evidence, confidence, risks and assumptions

### Requirement: Enrich without automatic binding

The system SHALL use only fixed read-only EasyEDA library search to enrich draft rows and SHALL NOT automatically bind a candidate or modify EDA documents.

#### Scenario: Search finds candidates
- **WHEN** a draft row includes a model or LCSC number
- **THEN** up to three normalized candidates are attached for user review
- **AND** the row remains unbound

### Requirement: Apply only after project-scoped confirmation

The system SHALL write draft rows to the selected project's local BOM only after explicit user confirmation.

#### Scenario: User confirms a draft
- **WHEN** the user confirms a reviewable draft
- **THEN** its rows are applied to the current project BOM and audited
- **AND** unrelated BOM rows remain unchanged

#### Scenario: User switches or resets chat
- **WHEN** the user switches projects
- **THEN** each project's draft and history are restored independently
- **WHEN** the user creates a new chat
- **THEN** chat drafts are cleared but confirmed requirements, assets and BOM remain
