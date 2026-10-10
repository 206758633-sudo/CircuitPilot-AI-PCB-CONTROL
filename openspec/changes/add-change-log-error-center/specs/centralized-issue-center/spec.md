## ADDED Requirements

### Requirement: Aggregate persistent issues from controlled sources
The system SHALL maintain a centralized issue collection for AI task failures, EDA bridge and command errors, blocked write attempts, failed or warning validations, persistence faults, and captured runtime errors. Each issue SHALL contain a source, severity, status, error code, summary, technical detail, first and latest occurrence, occurrence count, and available project, task, object, command, plan, or version context.

#### Scenario: AI task fails
- **WHEN** a simulated AI task enters the failed state
- **THEN** the system creates or updates a persistent AI issue containing the task identifier, plan hash, failed phase, error message, affected objects, and available recovery actions

#### Scenario: EDA write command is blocked
- **WHEN** a write command is blocked by missing approval, paused write policy, disconnected bridge, or unselected window
- **THEN** the system records a warning issue with the command, blocking gate, target context, and suggested action

#### Scenario: Repeated error has the same fingerprint
- **WHEN** an unresolved issue recurs with the same source, code, and related object fingerprint
- **THEN** the system increments its occurrence count and latest occurrence time instead of creating an indistinguishable duplicate row

### Requirement: Display global unresolved issue status
The system SHALL show the unresolved issue count and highest open severity in the versions/logs navigation item and the top status area, and SHALL provide a direct action to open the issue center.

#### Scenario: Critical issue is open
- **WHEN** at least one critical unresolved issue exists
- **THEN** the global indicator uses the critical visual state and displays the total unresolved count without relying only on a temporary Toast

#### Scenario: All issues are resolved or ignored
- **WHEN** no open or investigating issues remain
- **THEN** the indicator shows a healthy state and a zero unresolved count

### Requirement: Search and inspect issue reports
The system SHALL provide a dedicated issue-center view with search and source, severity, and status filters, and SHALL provide a detail drawer containing a plain-language explanation, technical context, chronology, relationship identifiers, suggested actions, and handling history.

#### Scenario: Filter unresolved EDA errors
- **WHEN** the user selects EDA source and open status
- **THEN** only unresolved EDA issues are displayed and the visible count updates

#### Scenario: Open technical details
- **WHEN** the user opens an issue
- **THEN** the detail view shows the error code, raw Demo response or safe error detail, occurrence history, related task/object/command, and recommended next step

### Requirement: Provide explicit issue handling actions
The system SHALL allow permitted issues to be marked investigating, resolved, reopened, or ignored with a mandatory reason, and SHALL offer source-appropriate actions such as retry, navigate to source, create AI fix task, or copy diagnostic details.

#### Scenario: Ignore requires a reason
- **WHEN** the user chooses to ignore an issue without entering a reason
- **THEN** the confirmation action remains disabled and the issue status does not change

#### Scenario: Resolve an issue
- **WHEN** the user records a resolution note and confirms resolution
- **THEN** the issue becomes resolved, retains its original error details, records who handled it and when, and updates the global unresolved count

#### Scenario: Create AI fix task from an issue
- **WHEN** an EDA or validation issue supports AI remediation and the user chooses create fix task
- **THEN** the system opens the AI task page with a draft goal containing the issue code, affected object, safe technical context, and expected verification

#### Scenario: Retry a recoverable source action
- **WHEN** the user retries a recoverable Demo issue
- **THEN** the system invokes only its registered typed recovery action, records the result, and never executes arbitrary code from issue text

### Requirement: Protect diagnostic data boundaries
The system SHALL avoid exposing secrets, arbitrary local file contents, API keys, model chain-of-thought, or unrestricted executable error payloads in issue details and exports.

#### Scenario: Runtime error contains unsafe data
- **WHEN** captured error metadata contains an API-key-like field or unrestricted object payload
- **THEN** the system stores and displays a redacted safe representation instead of the sensitive value

#### Scenario: Export issue report
- **WHEN** the user confirms a Demo diagnostic download
- **THEN** the export includes safe issue records and handling history, is marked DEMO ONLY, and excludes secret or reasoning content

### Requirement: Retain issue history through resettable local persistence
The system SHALL persist the latest 300 issue records in Schema v2 local state, SHALL preserve resolved and ignored issues for traceability, and SHALL clear them only through the existing confirmed Demo reset.

#### Scenario: Refresh after resolving an issue
- **WHEN** the user resolves an issue and refreshes the application
- **THEN** the issue remains resolved with its handling note and timestamps intact

#### Scenario: Confirm Demo reset
- **WHEN** the user confirms resetting Demo data
- **THEN** issue records and modification logs return to their v2 seed values and the interface reports successful reset
