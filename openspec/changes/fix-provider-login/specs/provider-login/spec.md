## ADDED Requirements

### Requirement: Observable CLI login startup
The Runtime SHALL confirm whether a registered provider is already authenticated, successfully started, exited early, or failed to spawn. It SHALL NOT report a detached PID as proof of successful login.

#### Scenario: Already logged in
- **WHEN** Codex status is authenticated before login begins
- **THEN** Runtime returns `already_authenticated` without launching another flow

#### Scenario: CLI exits during startup
- **WHEN** the login process exits before an authentication flow is established
- **THEN** Runtime returns a structured failure with a redacted message

### Requirement: Automatic status refresh
The client SHALL poll provider status after a login flow starts and SHALL stop on authenticated status, terminal startup failure, component unmount or a bounded timeout.

#### Scenario: Browser authorization completes
- **WHEN** the CLI status becomes authenticated during polling
- **THEN** the UI updates the provider to ready without requiring manual refresh

### Requirement: Runtime contract compatibility
The client SHALL reject the repaired login action when connected to a Runtime that does not expose the required login contract version.

#### Scenario: Stale Runtime
- **WHEN** the active Runtime is older than 0.6.1
- **THEN** the UI explains that CircuitPilot/Runtime must be fully restarted instead of reporting that login started
