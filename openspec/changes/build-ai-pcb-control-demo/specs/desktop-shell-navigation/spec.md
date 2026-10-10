## ADDED Requirements

### Requirement: Desktop application shell
The system SHALL present a macOS-oriented desktop shell containing a persistent sidebar, top status bus, page workspace, global notification layer, and an explicit demo-mode indicator.

#### Scenario: Initial application load
- **WHEN** the user opens the Demo for the first time
- **THEN** the system displays the project overview, eight primary navigation entries, AI/EDA/permission/task statuses, and a visible “演示模式” label

#### Scenario: Narrow desktop window
- **WHEN** the viewport is narrower than the primary desktop breakpoint
- **THEN** the system preserves access to all primary navigation and core page actions without horizontal loss of controls

### Requirement: Complete primary navigation
The system SHALL allow the user to navigate to 项目、需求、BOM与资料、AI任务、EDA控制台、验证、版本与日志、设置 and SHALL synchronize the current page with the URL hash.

#### Scenario: Navigate to each primary page
- **WHEN** the user selects any primary navigation item
- **THEN** the corresponding page content, page title, active navigation state, and URL hash update together

#### Scenario: Restore current page
- **WHEN** the user reloads the application with a recognized page hash
- **THEN** the system restores that page as the active destination

### Requirement: Universal control feedback
Every visible interactive control SHALL produce an observable outcome or SHALL be explicitly disabled with an accessible explanation.

#### Scenario: Activate a functional control
- **WHEN** the user activates a button, tab, filter, menu item, row action, switch, or icon control
- **THEN** the system performs navigation, changes state, opens a view, starts a simulated action, downloads a demo artifact, or displays feedback

#### Scenario: Encounter a disabled control
- **WHEN** a control is unavailable because of workflow state
- **THEN** the control is visibly disabled and the interface explains the prerequisite through adjacent text or an accessible description

### Requirement: Global dialogs and notifications
The system SHALL provide reusable modal, drawer, confirmation, toast, and command-palette interactions with keyboard-accessible close behavior.

#### Scenario: Confirm a consequential demo action
- **WHEN** the user requests reset, rollback, export, or another consequential simulated action
- **THEN** the system shows the target and impact before accepting confirmation

#### Scenario: Close an overlay
- **WHEN** the user selects cancel, the close control, or presses Escape where allowed
- **THEN** the overlay closes without applying the pending action

