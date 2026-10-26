## ADDED Requirements

### Requirement: Demo provider settings
The system SHALL allow users to select a simulated AI provider and model, adjust budget and behavior settings, test the simulated connection, and display that no real credential is used.

#### Scenario: Test provider connection
- **WHEN** the user selects test connection
- **THEN** the system returns a timed demo result for the selected provider without transmitting credentials

#### Scenario: Change provider settings
- **WHEN** the user changes provider, model, or budget and saves
- **THEN** the settings persist locally and the global AI status reflects the saved configuration

### Requirement: Permission preferences
The system SHALL allow the user to configure default read-only mode, automatic snapshot, automatic save, export confirmation, and write-pause preferences without bypassing task approval.

#### Scenario: Disable all write operations
- **WHEN** the user enables the global write pause
- **THEN** all write actions across AI tasks and EDA control become unavailable with a visible paused status

#### Scenario: Change a non-security preference
- **WHEN** the user changes a demo preference
- **THEN** the setting applies immediately and persists after reload

### Requirement: Local persistence
The system SHALL persist valid demo state to a versioned local storage record and SHALL recover safely from missing or malformed records.

#### Scenario: Reload persisted state
- **WHEN** the user reloads after making Demo changes
- **THEN** the active project, page, task state, settings, and user-created records are restored

#### Scenario: Encounter malformed storage
- **WHEN** the stored state cannot be parsed or validated
- **THEN** the system loads safe seed data and records a non-sensitive warning

### Requirement: Reset and diagnostic controls
The system SHALL support resetting only this Demo's local data and exporting a sanitized diagnostic summary after confirmation.

#### Scenario: Cancel data reset
- **WHEN** the user opens reset confirmation and cancels
- **THEN** no local Demo data changes

#### Scenario: Confirm data reset
- **WHEN** the user confirms reset
- **THEN** the system clears only the versioned Demo storage key, reloads seed data, and displays completion feedback

#### Scenario: Export diagnostics
- **WHEN** the user confirms diagnostic export
- **THEN** the downloaded demo report excludes secrets and clearly identifies simulated data
