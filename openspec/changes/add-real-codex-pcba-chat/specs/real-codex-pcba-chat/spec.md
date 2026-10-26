## ADDED Requirements

### Requirement: Codex account backed conversation
The system SHALL use the authenticated local Codex account through the local Runtime for AI chat and SHALL NOT require an API key for this provider.

#### Scenario: Send a message with a ready Codex account
- **WHEN** the user sends a non-empty message and the Codex account is ready
- **THEN** the system creates or resumes a Codex thread and returns a real assistant response

#### Scenario: Codex account is unavailable
- **WHEN** the user attempts to chat while Codex CLI is missing, logged out, or the Runtime is unreachable
- **THEN** the system blocks the request, shows a specific recovery action, and records the issue

### Requirement: Continuous PCBA clarification
The system SHALL preserve a conversation session and instruct the assistant to identify missing, conflicting, or ambiguous PCBA inputs before proposing downstream design work.

#### Scenario: Information is incomplete
- **WHEN** current requirements omit a decision that affects electrical, mechanical, manufacturing, compliance, or test feasibility
- **THEN** the assistant asks concise follow-up questions and labels the unresolved items

#### Scenario: Start a new conversation
- **WHEN** the user selects new conversation and confirms the action
- **THEN** the system clears the local transcript, discards the Runtime thread mapping, and retains project requirements already accepted by the user

### Requirement: Human-confirmed structured suggestions
The system SHALL represent AI-proposed requirement additions or updates as pending suggestions and SHALL update the requirement library only after explicit user acceptance.

#### Scenario: Accept a new requirement suggestion
- **WHEN** the user accepts a pending new requirement suggestion
- **THEN** the system creates a suggested requirement, records its AI chat source, and writes an audit and change-log entry

#### Scenario: Accept an update suggestion
- **WHEN** the user accepts a pending suggestion targeting an existing requirement
- **THEN** the system updates that requirement, preserves the previous value in the change log, and marks the suggestion accepted

#### Scenario: Reject a suggestion
- **WHEN** the user rejects a pending suggestion
- **THEN** the system leaves the requirement library unchanged and marks the suggestion rejected

### Requirement: Usable chat interaction
The system SHALL provide message history, multiline input, sending feedback, empty-state guidance, failure recovery, and disabled states that prevent duplicate turns.

#### Scenario: A turn is in progress
- **WHEN** the assistant is processing a message
- **THEN** the page shows the active state and prevents a second concurrent send

#### Scenario: A turn fails
- **WHEN** the Runtime or Codex turn fails or times out
- **THEN** the user message remains visible, a recoverable error is shown, and the user can retry

