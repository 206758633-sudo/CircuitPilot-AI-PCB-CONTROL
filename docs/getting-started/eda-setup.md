# EDA setup

CircuitPilot controls a **locally running** EDA editor through its debugging
interface. Nothing is sent to a remote service.

## 嘉立创EDA Professional (primary target)

1. Install and sign in to 嘉立创EDA Professional.
2. Open the target project (and the schematic/PCB document you intend to use).
3. Start the editor with remote debugging enabled (CDP port, default `9222`).
4. In CircuitPilot Settings, refresh local status and confirm the EDA chip is
   detected.
5. Use **EDA 执行** to inspect the target identity before any write.

## EasyEDA (secondary)

CircuitPilot can connect to a local EasyEDA bridge (default port `49620`) for
library/search workflows. The bridge is an optional external component; it is
not bundled here.

## Safety

- Start with a disposable test project.
- Writes require explicit approval and are followed by read-back + ERC/DRC.
- If the editor is not the intended target, stop and re-check identity.
- Never run write tests against a board you cannot restore.
