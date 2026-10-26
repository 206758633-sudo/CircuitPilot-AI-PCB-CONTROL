## 1. State and persistence

- [x] 1.1 Add schema-v4 project chat storage and deterministic empty-chat creation
- [x] 1.2 Migrate the v3 global chat to the previously active project
- [x] 1.3 Add reducer behavior for project switching, current-project chat updates, reset, and deletion cleanup

## 2. User interface

- [x] 2.1 Add permanent project deletion with explicit disk/EDA safety wording
- [x] 2.2 Add the AI target-project selector and project-memory status
- [x] 2.3 Keep new-chat reset scoped to the selected project

## 3. Verification

- [x] 3.1 Add reducer coverage for independent histories, reset isolation, migration, and deletion
- [x] 3.2 Add E2E coverage for project deletion and cross-project chat restoration
- [x] 3.3 Run typecheck, unit/runtime tests, build, E2E, and strict OpenSpec validation
