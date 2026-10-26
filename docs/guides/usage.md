# Usage

## 1. Create or open a project

Add a project on the **Projects** page, or select an existing one. A project
records the local working directory and the EDA project identity.

## 2. Describe the requirement

Use **AI 设计** to chat about the requirement. The console turns the agreed
requirement into design facts and a structured plan. You can inspect and edit
the plan before any write.

## 3. Execute in EDA (controlled)

The **EDA 执行** page shows the target, plan, and approval state. A write is
rejected if:
- the target identity is missing or ambiguous,
- the plan is incomplete, or
- the required human approval is absent.

After a write, the Runtime reads back the result and runs ERC/DRC.

## 4. Validate

**验证与交付** collects:
- schematic ERC evidence,
- PCB DRC evidence,
- pin/net audits,
- optional simulation evidence,
- manual DFM and sign-off records.

Missing evidence is shown as missing. It is never displayed as "passed".

## 5. Release gate

The gate aggregates the evidence and reports blockers. Even when everything
is ready, the product does not place orders or make payments; that remains a
human action on the fabricator's site.

## 6. Knowledge (optional)

The knowledge/RAG features help retrieve design rules and failure cases. The
public repository ships the mechanism and example docs, not a proprietary
customer dataset.
