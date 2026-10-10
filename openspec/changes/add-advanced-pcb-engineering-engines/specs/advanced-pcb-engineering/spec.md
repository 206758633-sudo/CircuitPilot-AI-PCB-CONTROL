## ADDED Requirements

### Requirement: Evidence-bound stackup
系统 SHALL require a versioned fabricator stackup and material evidence before impedance, high-speed or RF results can pass.

#### Scenario: Missing dielectric evidence
- **WHEN** dielectric constant or dielectric height is absent
- **THEN** impedance analysis is blocked instead of using a silent default

### Requirement: High-speed digital analysis
系统 SHALL evaluate differential impedance, skew, length, crosstalk clearance and reference-plane continuity for supported high-speed profiles.

#### Scenario: USB pair crosses a plane split
- **WHEN** a USB 2.0 segment lacks a continuous reference plane
- **THEN** the result is blocking and a stitching/route correction is proposed

### Requirement: HDI via planning
系统 SHALL select only fabricator-supported via transitions and sequential-lamination structures through a deterministic layer graph.

#### Scenario: Unsupported stacked microvia
- **WHEN** a requested transition exceeds the approved stack count
- **THEN** no via operation is compiled

### Requirement: RF analysis boundary
系统 SHALL identify analytical estimates separately from external electromagnetic simulation and require simulation evidence for RF release.

#### Scenario: 2.4GHz line has only an analytical estimate
- **WHEN** no external simulation result is attached
- **THEN** RF production readiness remains blocked

### Requirement: Reviewable layout and silkscreen
系统 SHALL produce deterministic placements, scores, collision findings and silkscreen anchors that can be reviewed before嘉立创EDA mutation.

#### Scenario: Reference text overlaps a pad
- **WHEN** every candidate anchor intersects a forbidden region
- **THEN** the text is left unresolved and the plan cannot claim completion
