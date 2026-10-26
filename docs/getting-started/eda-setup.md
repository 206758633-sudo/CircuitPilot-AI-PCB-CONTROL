# EDA setup

CircuitPilot controls a **locally running** EDA editor. Nothing is sent to a
remote service.

## 嘉立创EDA Professional (primary target)

1. Install and sign in to 嘉立创EDA Professional.
2. Open the target project (and the schematic/PCB document you intend to use).
3. Install the official **`run-api-gateway` (API Gateway)** extension from the
   EDA extension marketplace, and enable **External Interaction Permission**.
   CircuitPilot does not redistribute this official extension.
4. Start the editor with remote debugging enabled. You can either:
   - click **启动EDA** in CircuitPilot's **EDA 执行** page (recommended), or
   - run the terminal command in `docs/guides/user-manual.zh-CN.md` §5.2.
5. CircuitPilot starts its local bridge daemon automatically; the bridge listens
   on `127.0.0.1:49620–49629` and is protected by a per-launch token.
6. In CircuitPilot Settings, refresh local status and confirm the EDA chip is
   detected.
7. Use **EDA 执行** to inspect the target identity before any write.

## EasyEDA (secondary)

CircuitPilot can also use a local `easyeda-bridge` service for EasyEDA
workflows. The primary target is 嘉立创EDA Professional; EasyEDA is optional.

## Safety

- Start with a disposable test project.
- Writes require explicit approval and are followed by read-back + ERC/DRC.
- If the editor is not the intended target, stop and re-check identity.
- Never run write tests against a board you cannot restore.
- The bridge only binds loopback. Do not expose it to a LAN or the public
  internet, and do not disable the per-launch token.
