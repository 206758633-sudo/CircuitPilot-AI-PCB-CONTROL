# AI chat attachments

## ADDED Requirements

### Requirement: Upload bounded evidence to an AI chat turn

The system SHALL allow up to four supported image or text evidence attachments in one project-scoped AI chat turn.

#### Scenario: Send a supported image

- **WHEN** the user attaches a PNG, JPEG, WebP or GIF whose content signature matches its declared MIME type and is no larger than 5 MB
- **THEN** Runtime passes it to Codex as a local image input
- **AND** removes the temporary file after the turn completes or fails

#### Scenario: Send a supported text file

- **WHEN** the user attaches a supported text engineering file within the configured bounds
- **THEN** its bounded text is included as untrusted evidence
- **AND** instructions inside the attachment do not override system or developer instructions

#### Scenario: Reject invalid or unsupported content

- **WHEN** an attachment exceeds a limit, uses an unsupported binary format, contains malformed Base64, or does not match its declared image format
- **THEN** the request is rejected with an explicit error
- **AND** the system does not claim the attachment was analyzed

### Requirement: Persist attachment metadata without raw content

The system SHALL persist only attachment metadata with the selected project's chat message.

#### Scenario: Restore project chat history

- **WHEN** the user returns to a project with messages containing attachments
- **THEN** the attachment name, MIME type, size and kind are restored
- **AND** raw image or text content is not stored in browser persistence
