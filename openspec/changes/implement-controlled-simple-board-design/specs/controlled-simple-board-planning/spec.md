## ADDED Requirements

### Requirement: Produce a structured simple-board plan
The system SHALL transform the conversation into a schema-valid plan covering MCU, power, LED, button, exact component identities, nets, placements, connections, checks, assumptions, and unresolved questions.

#### Scenario: Required component identity is unknown
- **WHEN** any required component lacks an exact approved library identity or required electrical value
- **THEN** the plan remains blocked and lists the missing information instead of selecting a substitute

#### Scenario: Complete information is supplied
- **WHEN** all required identities, values, connections, and constraints are known
- **THEN** the Runtime emits a normalized executable candidate plan and its stable SHA-256 hash

### Requirement: Bind human approval to immutable execution intent
The Runtime MUST issue a short-lived single-use approval token bound to the normalized plan hash, target fingerprint, selected window, approved step set, and expiry time.

#### Scenario: Approved plan is modified
- **WHEN** any executable plan field changes after approval
- **THEN** its hash no longer matches and execution is rejected

#### Scenario: Approval token is replayed
- **WHEN** a consumed or expired approval token is submitted
- **THEN** execution is rejected and the replay is logged

### Requirement: Keep AI outside the execution boundary
The AI provider SHALL only return structured planning data and SHALL NOT provide executable JavaScript to the 嘉立创EDA bridge.

#### Scenario: Model output contains an unsupported action
- **WHEN** the candidate plan requests a command outside the fixed schema
- **THEN** validation rejects the plan before approval

