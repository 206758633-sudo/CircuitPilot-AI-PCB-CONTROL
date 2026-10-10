## 1. PCB API evidence and contracts

- [x] 1.1 Inventory and verify the exact 嘉立创EDA V3.2.175 APIs for schematic-to-PCB synchronization, PCB documents, primitives, rules, DRC, 3D, and production export
- [x] 1.2 Add versioned Runtime schemas for PCB evidence, semantic plans, compiled operations, approvals, stages, validations, and recovery; frontend/artifact fields remain in tasks 5 and 6
- [x] 1.3 Implement fixed PCB read commands and target fingerprinting for document, layers, rules, nets, components, tracks, vias, pours, text, and source digest (pad detail remains derived from components)
- [x] 1.4 Add capability probing that reports each supported, experimental, unavailable, or user-assisted production operation without overstating readiness

## 2. Controlled PCB mutation and recovery

- [x] 2.1 Add strictly validated fixed commands for schematic-to-PCB synchronization and PCB document save
- [x] 2.2 Add fixed board-outline line, component-placement, track, via, and copper-pour commands using documented layer IDs and units; rule/silkscreen write remains blocked pending final contracts
- [x] 2.3 Implement PCB stage snapshots, bounded batches, progress heartbeats, readback checks, rollback verification, and rollback-failed lockout
- [x] 2.4 Bind single-use approvals to compiled plan hash, target fingerprint, window, stages, and expiry; object-scope refinement remains with staged execution
- [x] 2.5 Add Runtime tests for unknown commands, invalid geometry/layers, target drift, replay, partial mutation, timeout, DRC failure, and recovery

## 3. Codex PCBA orchestration

- [x] 3.1 Extend Codex chat output with a versioned evidence-constrained PCBA semantic plan and precise blocking-information responses
- [x] 3.2 Implement deterministic compilation for the approved CH32V003 outline and placement intent to fixed PCB operations and stable plan hashes
- [ ] 3.3 Persist confirmed project facts, plan versions, decisions, execution evidence, unresolved issues, and refreshed EDA target state
- [x] 3.4 Prevent model-generated scripts and require explicit approval transitions for PCB writes and production exports

## 4. Layout, routing, and validation

- [x] 4.1 Implement manufacturing and electrical rule profiles for two-layer low-cost 嘉立创 fabrication and project-specific overrides
- [ ] 4.2 Implement deterministic placement constraints for edge connectors, power, decoupling, MCU, LED, button, and programming header (2026-08-25已实现确定坐标编译、板内/板边/碰撞检查；自动区域求解仍需扩展)
- [ ] 4.3 Implement critical-net-first routing, vias, ground strategy, copper pours, silkscreen, and board-edge clearance checks (2026-08-25已实现网络类别线宽、确定性曼哈顿走线、GND覆铜和板边检查；通用过孔/丝印及复杂回流路径仍需扩展)
- [x] 4.4 Implement official PCB DRC and available 3D-file gates with structured evidence; netlist/unrouted/DFM remain blocked until synchronized PCB exists
- [x] 4.5 Add quality metrics and an explicit human final-review gate after automated validation

## 5. Production artifacts

- [ ] 5.1 Implement independently approved BOM, CPL, Gerber, drill, and review-package export commands where supported by documented APIs
- [x] 5.2 Validate Gerber layer set, drill presence, BOM fields, CPL fields, reference-designator sets, rotations, sides, and file hashes
- [x] 5.3 Generate an immutable production manifest bound to project, document, source digest, plan hash, execution, checks, and artifacts
- [x] 5.4 Expose procurement identity separately from live stock, price, and assembly availability, retaining a manual-review state when live evidence is unavailable

## 6. Desktop production workspace

- [ ] 6.1 Update the AI page to complete production requirements, preserve decisions, and hand an immutable plan to approval (2026-08-25已增加真实Codex语义计划生成、阻断问题和计划哈希；候选计划跨重启持久化与一键交接仍待完成)
- [x] 6.2 Update the EDA page with a real PCB capability matrix and dedicated context, compile, validation, approval, execution, readback, DRC, recovery, and lockout controls
- [ ] 6.3 Update validation, assets/BOM, versions/logs, and issue center pages for real PCB checks and production artifacts (2026-08-25已完成生产资料页的真实文件、哈希、字段、位号、Gerber层集、DFM交接和阻断展示；验证总览与版本页仍需统一)
- [x] 6.4 Remove or clearly isolate remaining simulated production claims and ensure unavailable capabilities cannot appear complete

## 7. CH32V003 live acceptance and delivery

- [x] 7.1 Re-read the completed CH32V003 schematic and verify physical component footprints before PCB synchronization; PCB net evidence remains blocked by empty synchronization readback
- [ ] 7.2 Rehearse PCB source snapshot, restore, save, and digest verification on the dedicated project without retaining changes
- [ ] 7.3 Execute the approved 45×30mm two-layer board outline and placement, then record complete readback evidence
- [ ] 7.4 Execute routing, vias, pours, and silkscreen; pass official netlist and PCB DRC with zero blocking findings
- [ ] 7.5 Generate and validate the approved production artifact package without ordering or payment
- [ ] 7.6 Run typecheck, unit/integration tests, E2E, build, OpenSpec strict validation, and record the live acceptance and successful-execution lessons
- [ ] 7.7 Restore the project to its checkout directory, restart services, verify URLs, and deliver an exact completed/blocked capability report
