# Change: Repair observable provider account login

## Why

CLI login is currently spawned detached with all output discarded. The UI reports success before confirming process startup, cannot show immediate CLI failures, and never polls authentication status. A stale Runtime can also be presented as usable.

## What Changes

- Replace fire-and-forget login startup with an observable bounded startup handshake.
- Return already-authenticated, started, process-exited and startup-error states without exposing credentials.
- Poll provider status after login and stop on success, terminal failure or timeout.
- Require Runtime 0.6.1 for the repaired login contract and surface stale-runtime remediation.
- Add unit, Runtime API and E2E regression coverage.

## Safety

- Only fixed registered CLI executables and fixed login arguments may run.
- OAuth URLs, authorization codes and tokens must not enter audit logs.
- Login remains an explicit user action and does not modify PCB data.
