# Project chat memory

## ADDED Requirements

### Requirement: Select a target project for AI conversation

The AI page SHALL provide a project selector and SHALL use the selected project as the current structured AI context.

#### Scenario: Switch projects

- **WHEN** the user selects another project while no message is sending
- **THEN** the current work project changes
- **AND** the selected project's saved messages, session ID, suggestions, errors, and EDA evidence are restored

### Requirement: Persist isolated conversation memory

The application SHALL persist one independent `ChatState` per project ID.

#### Scenario: Return to a previous project

- **WHEN** the user sends messages in project A, switches to project B, then returns to project A
- **THEN** project A's conversation is restored
- **AND** project B's conversation does not appear in project A

#### Scenario: Start a new conversation

- **WHEN** the user confirms new conversation for the selected project
- **THEN** only that project's chat history and Runtime session are reset
- **AND** project requirements and assets remain unchanged
