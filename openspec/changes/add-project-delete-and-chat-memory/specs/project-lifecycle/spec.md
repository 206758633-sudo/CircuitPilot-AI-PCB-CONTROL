# Project lifecycle

## ADDED Requirements

### Requirement: Permanently delete an application project

The application SHALL allow a user to permanently delete any project after explicit confirmation.

#### Scenario: Delete the active project

- **WHEN** the user confirms deletion of the active project
- **THEN** the project and its project-keyed AI conversation are removed from persisted application state
- **AND** another remaining project becomes active when available
- **AND** no local workspace path or EasyEDA project file is deleted or modified

#### Scenario: Delete the last project

- **WHEN** the user confirms deletion of the only remaining project
- **THEN** the application enters a valid no-project state and still allows creating a new project
