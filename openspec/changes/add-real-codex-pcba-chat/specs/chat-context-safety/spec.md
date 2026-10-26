## ADDED Requirements

### Requirement: Bounded project context
The system SHALL send only bounded, structured project data needed for PCBA clarification: active project metadata, requirements, BOM rows, asset metadata, and fixed 嘉立创EDA readbacks.

#### Scenario: Build chat context
- **WHEN** a user sends a chat message
- **THEN** the frontend sends the active project context without credentials, arbitrary local file contents, or hidden application state

#### Scenario: Context exceeds limits
- **WHEN** the submitted message or context exceeds configured limits
- **THEN** the Runtime rejects it with a specific validation error and does not start a Codex turn

### Requirement: Read-only Codex execution boundary
The Runtime SHALL start Codex chat threads in read-only sandbox mode with approvals disabled and SHALL instruct the assistant not to modify files, invoke shell commands, or claim EDA changes.

#### Scenario: Codex thread is created
- **WHEN** the Runtime creates a chat thread
- **THEN** it sets the workspace directory, read-only sandbox, never-approve policy, and PCBA clarification instructions

#### Scenario: Approval request is emitted
- **WHEN** Codex requests command, file, network, or external permission approval
- **THEN** the Runtime denies the request, fails the turn safely, and records a security issue

### Requirement: Fixed 嘉立创EDA evidence boundary
The Runtime SHALL obtain EDA context only through registered read-only Bridge commands and SHALL distinguish unavailable data from confirmed empty data.

#### Scenario: One EDA window is available
- **WHEN** the Runtime can identify one selected EDA window
- **THEN** it reads current project and document information using the fixed allowlist and includes the results as evidence

#### Scenario: EDA context is unavailable
- **WHEN** the Bridge is stopped, no window is connected, or multiple windows require selection
- **THEN** chat remains available with an explicit unavailable status and no EDA claim is fabricated

### Requirement: Structured response validation
The Runtime SHALL constrain and validate the assistant response against a fixed JSON schema before returning it to the frontend.

#### Scenario: Valid assistant response
- **WHEN** Codex completes with a schema-valid response
- **THEN** the Runtime returns the reply, questions, and normalized requirement suggestions

#### Scenario: Invalid or incomplete assistant response
- **WHEN** the response cannot be parsed or violates the schema
- **THEN** the Runtime returns a safe protocol error without applying any requirement change

