# Runtime hardening

## ADDED Requirements

### Requirement: Validate image content at the Runtime boundary

Runtime SHALL reject malformed, empty, oversized or format-spoofed image attachments before creating a Codex turn.

#### Scenario: Declared MIME does not match image content

- **WHEN** an attachment declares a supported image MIME but its decoded signature does not match that format
- **THEN** Runtime returns `CHAT_ATTACHMENT_INVALID`
- **AND** no temporary model input is created

### Requirement: Keep current EDA read workflow covered

The end-to-end suite SHALL exercise the visible existing-design read action and verify synchronized PCB evidence.

#### Scenario: Read current design

- **WHEN** the user clicks `读取当前EDA设计`
- **THEN** the UI requests the current PCB context
- **AND** renders the synchronized state and primitive counts
