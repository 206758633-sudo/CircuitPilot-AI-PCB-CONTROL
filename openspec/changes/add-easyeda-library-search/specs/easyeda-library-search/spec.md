## ADDED Requirements

### Requirement: Search the EasyEDA device library from a BOM item

The system SHALL provide read-only EasyEDA device-library search for each BOM item by model keyword or LCSC part number.

#### Scenario: Search by keyword
- **WHEN** a user searches a valid model keyword
- **THEN** the system returns at most 20 normalized EasyEDA device candidates
- **AND** identifies the Beta evidence source

#### Scenario: Search by LCSC number
- **WHEN** a user searches a valid C number
- **THEN** the system uses the dedicated LCSC lookup API

### Requirement: Bind only after explicit selection

The system SHALL persist an EasyEDA device binding only after the user explicitly selects and confirms a search candidate.

#### Scenario: Confirm a candidate
- **WHEN** a user selects and confirms one candidate
- **THEN** its device, library, symbol, footprint and 3D identities are saved on the BOM item
- **AND** no schematic or PCB write occurs

### Requirement: Associate local evidence with an EasyEDA project

The system SHALL allow a local evidence item to store a reference to the current EasyEDA project without uploading or modifying that project.

#### Scenario: Link current project
- **WHEN** a user links a local evidence item to the current EasyEDA project
- **THEN** CircuitPilot stores the project name or UUID as local association metadata
- **AND** does not upload the evidence file to EasyEDA
