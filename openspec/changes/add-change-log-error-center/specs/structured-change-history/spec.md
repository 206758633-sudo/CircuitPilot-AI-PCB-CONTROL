## ADDED Requirements

### Requirement: Record structured engineering modifications
The system SHALL record a structured change entry for user-approved or simulated AI modifications to projects, requirements, assets, BOM components, task plans, EDA write actions, versions, validations, and settings. Each entry SHALL include time, source, actor, action, object identity, human-readable summary, changed fields, and available before/after values.

#### Scenario: User confirms a requirement change
- **WHEN** the user saves a changed requirement value
- **THEN** the system records the requirement name, previous value, new value, evidence source, user actor, and confirmation reason in the modification log

#### Scenario: AI task completes controlled changes
- **WHEN** a simulated controlled-write task completes
- **THEN** the system records the approved plan hash, selected steps, affected objects, task identifier, pre-task snapshot, and validation outcome as linked modification entries

#### Scenario: Read-only action does not create a modification
- **WHEN** the user or AI performs a read-only query without changing controlled state
- **THEN** the system retains an audit or command event but does not misclassify it as an engineering modification

### Requirement: Present searchable modification history
The system SHALL provide a dedicated modification-log view with search, source, object type, actor, and time filters, and SHALL present newest entries first.

#### Scenario: Filter changes for a design object
- **WHEN** the user searches for a component reference or filters by BOM source
- **THEN** the system displays only matching modification entries and updates the visible result count

#### Scenario: No modifications match
- **WHEN** active filters match no modification entries
- **THEN** the system shows an explicit empty state and provides an action to clear filters

### Requirement: Inspect modification details and differences
The system SHALL let the user open a modification detail view showing changed fields, before/after values, reason, related evidence, task, plan hash, version, snapshot, and validation status when available.

#### Scenario: View before and after values
- **WHEN** the user opens a requirement or BOM modification
- **THEN** the detail view clearly distinguishes the previous value from the new value and identifies fields with no prior value as additions

#### Scenario: Follow related context
- **WHEN** a modification contains a related task, version, requirement, component, or EDA command
- **THEN** the detail view provides a working navigation or focus action to the corresponding Demo context

### Requirement: Preserve and export traceability
The system SHALL include structured modifications in the clearly marked Demo diagnostic and engineering-review downloads, and SHALL preserve the latest 500 modification entries locally without silently deleting newer entries.

#### Scenario: Download review package
- **WHEN** the user confirms an engineering-review package download
- **THEN** the generated Demo package includes structured modification entries and their relationship identifiers

#### Scenario: Modification history reaches retention limit
- **WHEN** adding a modification would exceed 500 entries
- **THEN** the system retains the newest 500 entries and reports the retention policy in the modification-log interface

### Requirement: Migrate existing local Demo state
The system SHALL migrate a valid Schema v1 Demo state to Schema v2 by retaining existing project data and adding the modification-history fields required by this capability.

#### Scenario: Load existing v1 state
- **WHEN** the application starts with a valid v1 LocalStorage state and no v2 state
- **THEN** it produces a valid v2 state that retains projects, requirements, assets, BOM, task, EDA, validations, versions, audit, and settings

#### Scenario: Migration cannot parse legacy state
- **WHEN** the v1 state is corrupt or structurally invalid
- **THEN** the application loads v2 seed data and records a visible persistence issue after initialization
