## 1. Runtime Codex integration

- [x] 1.1 Implement a supervised Codex App Server stdio client with initialize, thread, turn, timeout, notification, and shutdown handling
- [x] 1.2 Define the bounded chat context and strict structured-output validation
- [x] 1.3 Add Runtime chat status, send-message, and reset-session endpoints with Codex readiness checks
- [x] 1.4 Aggregate only fixed 嘉立创EDA read commands into chat evidence and degrade safely when unavailable
- [x] 1.5 Add Runtime tests for successful chat, validation failures, unavailable Codex, reset, timeout, and EDA fallback

## 2. Frontend data and client

- [x] 2.1 Add schemaVersion 3 chat, message, question, and requirement-suggestion types with v2 migration defaults
- [x] 2.2 Add reducer actions for message lifecycle, suggestion decisions, and session reset
- [x] 2.3 Add typed Runtime chat client methods and actionable error mapping
- [x] 2.4 Add reducer and client tests for chat persistence and accepted/rejected requirement suggestions

## 3. Real AI chat page

- [x] 3.1 Replace the simulated AI task entry view with a continuous Codex PCBA clarification chat workspace
- [x] 3.2 Show active project context, requirement gaps, BOM and 嘉立创EDA evidence status
- [x] 3.3 Implement multiline send, quick prompts, in-flight state, retry, and confirmed new-conversation behavior
- [x] 3.4 Implement pending requirement suggestion cards with accept/reject actions and audit/change-log records
- [x] 3.5 Add responsive chat styling and accessible control states without exposing credentials or internal reasoning

## 4. Verification and documentation

- [x] 4.1 Run typecheck, unit tests, Runtime tests, production build, and OpenSpec validation
- [x] 4.2 Run browser E2E checks for chat empty, error, reset, and suggestion confirmation flows
- [x] 4.3 Perform one live Codex account chat smoke test and verify 嘉立创EDA remains read-only
- [x] 4.4 Update README and implementation record with startup, boundaries, troubleshooting, and verified evidence
