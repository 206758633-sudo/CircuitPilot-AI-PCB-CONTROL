## ADDED Requirements

### Requirement: EDA environment diagnostics
The system SHALL display simulated checks for macOS, 嘉立创EDA version and activation, Gateway permission, Bridge health, port, and connected windows.

#### Scenario: Run environment check
- **WHEN** the user selects environment check
- **THEN** each diagnostic item transitions through checking to a clear pass, warning, or failure state with next-step guidance

### Requirement: EDA connection control
The system SHALL simulate connect, disconnect, reconnect, pause-write, and window-selection actions while clearly showing that no real EDA is contacted.

#### Scenario: Connect one window
- **WHEN** the user starts connection with one simulated EDA window available
- **THEN** the system selects it, marks Bridge and EDA connected, and records a read-only query result

#### Scenario: Select among multiple windows
- **WHEN** multiple simulated EDA windows are enabled
- **THEN** the system requires the user to choose a window before write permission can be granted

#### Scenario: Disconnect during a task
- **WHEN** the user simulates disconnection while a task is active
- **THEN** the task pauses or fails safely and no later simulated command is executed

### Requirement: Typed command console
The system SHALL expose a safe catalog of simulated typed EDA commands and a chronological request-result console without accepting arbitrary executable code.

#### Scenario: Run a read-only command
- **WHEN** the user selects a permitted read command and executes it
- **THEN** the console appends a request entry and a structured mock response without changing design state

#### Scenario: Attempt a write command in read-only mode
- **WHEN** the current permission is read-only and the user selects a write command
- **THEN** the system disables execution and explains that an approved task is required

### Requirement: Connection session history
The system SHALL retain simulated connection, window selection, command, reconnect, and disconnect events in the local audit history.

#### Scenario: Inspect session events
- **WHEN** the user opens EDA session history
- **THEN** the system displays ordered events with time, window identity, command type, duration, and result

