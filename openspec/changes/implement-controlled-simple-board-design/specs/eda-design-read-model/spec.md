## ADDED Requirements

### Requirement: Read selected EasyEDA design context
The Runtime SHALL read the selected 嘉立创EDA window's current project, document, schematic catalog, components, component pins, wires, and net flags through fixed read-only commands and SHALL return a normalized model with capture time and raw evidence references.

#### Scenario: One selected schematic is readable
- **WHEN** one connected window is selected and its active document is a schematic
- **THEN** the Runtime returns a normalized design model containing stable target identifiers and schematic primitives without modifying the document

#### Scenario: No usable schematic is selected
- **WHEN** the selected window has no active schematic document
- **THEN** the Runtime returns a blocking diagnostic and executes no write command

### Requirement: Detect target drift
The Runtime MUST compute a target fingerprint from the window, project, document, schematic page, and current source digest and MUST compare it again before an approved write begins.

#### Scenario: User changes the active document after approval
- **WHEN** the live target fingerprint differs from the approved fingerprint
- **THEN** execution is rejected and a target-drift error is recorded

### Requirement: Avoid ambiguous window selection
The system MUST require explicit selection when more than one 嘉立创EDA window is connected and MUST NOT infer a target from window order.

#### Scenario: Two windows are connected
- **WHEN** an execution request has no selected window and two windows are available
- **THEN** the system requests target selection and performs no design operation

