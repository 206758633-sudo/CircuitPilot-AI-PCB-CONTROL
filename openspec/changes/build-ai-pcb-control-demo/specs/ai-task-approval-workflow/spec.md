## ADDED Requirements

### Requirement: AI task composition
The system SHALL allow the user to compose a natural-language goal, select task mode and scope, and request a simulated structured AI plan.

#### Scenario: Generate a plan with sufficient information
- **WHEN** the user submits a non-empty goal and blocking project requirements are resolved
- **THEN** the system displays a staged plan containing evidence, scope, steps, risks, verification, and rollback strategy

#### Scenario: Generate a plan with missing critical information
- **WHEN** blocking requirements remain unresolved
- **THEN** the system places the task in waiting-for-input state and lists the required questions instead of offering execution

### Requirement: Plan review and comparison
The system SHALL allow users to expand steps, inspect affected objects, compare a regenerated alternative, edit task scope, and reject or request revision.

#### Scenario: Regenerate an alternative
- **WHEN** the user requests another approach
- **THEN** the system displays a second plan with visible differences and requires a new approval decision

#### Scenario: Change plan scope
- **WHEN** the user removes or changes an allowed action
- **THEN** the plan hash and approval state change, invalidating any previous approval

### Requirement: Scoped approval
The system SHALL support approving all eligible steps or a selected subset and SHALL record the approved scope, plan identity, and demo user action.

#### Scenario: Approve selected steps
- **WHEN** the user selects eligible steps and confirms approval
- **THEN** only those steps become executable and the remaining steps stay unapproved

#### Scenario: Attempt execution without approval
- **WHEN** the user tries to execute a draft, changed, rejected, or partially unapproved step
- **THEN** the system blocks execution and displays the required approval action

### Requirement: Simulated task execution lifecycle
The system SHALL simulate snapshotting, execution, read-back, validation, success, failure, cancellation, and retry using visible progress states.

#### Scenario: Successful approved execution
- **WHEN** the user starts an approved demo task
- **THEN** the system advances through snapshotting, executing, read-back, and verification before completing with logs and results

#### Scenario: Cancel an executing task
- **WHEN** the user requests cancellation during a cancellable phase
- **THEN** the system stops before the next simulated step and records the task as cancelled

#### Scenario: Simulate a controlled failure
- **WHEN** the user enables failure simulation and runs an approved task
- **THEN** the system stops on the configured step, reports the error, and offers retry, revise, or rollback actions

