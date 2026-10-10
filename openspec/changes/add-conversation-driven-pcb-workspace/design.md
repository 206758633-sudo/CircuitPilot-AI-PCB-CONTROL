# Design

## Safety boundary

The embedded view is a synchronized read-only representation of Bridge evidence, not an iframe of the native app. AI never emits or executes arbitrary code. A natural-language turn produces a semantic candidate. Missing evidence yields blockers. A ready candidate is copied into the existing deterministic pipeline only after explicit confirmation; real writes still require target fingerprint binding, one-time approval, readback, DRC and rollback handling.

## UI flow

1. Read the active PCB and render a bounded SVG overview.
2. Submit a project-scoped design instruction.
3. Show the AI explanation, blockers or a reviewable structured change plan.
4. Confirm to prepare the plan in advanced controls; no write occurs at this step.
5. Use the existing approval/execution gate for the real EasyEDA change.

## Runtime

`POST /api/eda/app/focus` launches only the discovered fixed EasyEDA application path. `POST /api/production/plans/ai` accepts a bounded `instruction` and includes it in the evidence prompt without changing the strict output schema.

`POST /api/eda/workspaces` launches the fixed installed EasyEDA app, waits up to 15 seconds for the verified Bridge identity, rejects ambiguous multi-window state, then executes one registered creation command. The command uses the documented Beta project/board/schematic/PCB creation APIs, opens the created PCB, and returns all created UUIDs for readback. It never accepts arbitrary code or paths.
