## ADDED Requirements

### Requirement: Execute only fixed typed schematic commands
The Runtime SHALL expose a versioned allowlist for source snapshot, component creation, wire creation, net-flag creation, save, readback, schematic DRC, and source restore; every command MUST validate its arguments and permission.

#### Scenario: Arbitrary source code is submitted
- **WHEN** a client submits JavaScript or an unregistered command identifier
- **THEN** the Runtime rejects it without forwarding it to the bridge

### Requirement: Create a true pre-write source snapshot
The Runtime MUST obtain the active document source through `sys_FileManager.getDocumentSource`, record its SHA-256 digest and protected local payload, and verify that a non-empty snapshot exists before the first design mutation.

#### Scenario: Snapshot API is unavailable
- **WHEN** source capture returns undefined, empty data, or an error
- **THEN** execution stops before any schematic write and records a blocking snapshot error

### Requirement: Verify every write by readback
The Runtime MUST record returned primitive identifiers, save the document, read the affected primitives again, and compare their identities, positions, nets, and connections with the approved plan.

#### Scenario: A created wire is absent after save
- **WHEN** readback cannot find a required primitive or its normalized fields differ
- **THEN** execution fails and enters recovery without running the remaining validation gate

### Requirement: Run official schematic DRC
After successful save and readback, the Runtime MUST call 嘉立创EDA `sch_Drc.check(true, false, true)` and SHALL label the result as schematic DRC (ERC equivalent) with the returned details.

#### Scenario: Official DRC passes
- **WHEN** the official call returns an empty detailed-error array
- **THEN** the DRC gate is marked passed with timestamp and target fingerprint

#### Scenario: Official DRC reports or cannot run
- **WHEN** the official call returns errors, throws, is unavailable, or has an unknown response shape
- **THEN** the task is not marked successful and the exact result is recorded without substituting a custom check

### Requirement: Restore from the pre-write snapshot on execution failure
When a mutation has begun and a required write, save, readback, or validation step fails, the Runtime MUST restore the captured source with `sys_FileManager.setDocumentSource`, save, and verify the restored source digest before reporting rollback success.

#### Scenario: Recovery succeeds
- **WHEN** restoration, save, and digest verification all succeed on the unchanged target
- **THEN** the execution state becomes `rolled_back` and the audit record links the snapshot and failure

#### Scenario: Recovery cannot be verified
- **WHEN** restoration fails, the target changed, or the digest differs
- **THEN** the state becomes `rollback_failed`, further writes remain disabled, and a high-priority error provides manual recovery evidence

### Requirement: Preserve a complete local audit trail
The Runtime SHALL append events for plan creation, approval, target verification, snapshot, each fixed command, save, readback, DRC, recovery, and final state without logging API secrets or raw document source.

#### Scenario: User opens change and error history
- **WHEN** the user views an execution record
- **THEN** the UI shows ordered stages, durations, sanitized inputs/results, snapshot digest, error details, and recovery status

