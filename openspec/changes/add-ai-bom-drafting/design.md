# Safety and workflow

The chat model emits a bounded `bomDraft` object. `status=blocked` requires blocking questions and cannot be confirmed. `status=draft` contains normalized component rows with evidence, confidence, assumptions and a confirmation state.

After model output, Runtime performs only documented read-only `library.device.search` calls. It may attach up to three candidates to each row. Candidate identity is evidence for review, not an automatic binding.

The UI stores the draft inside the assistant chat message. Clicking “确认写入当前项目BOM” converts draft rows into local `ComponentItem` records. Existing rows with the same normalized reference designator are replaced only after the confirmation dialog explicitly states the scope; unrelated rows remain unchanged. No EDA mutation is invoked.

# Missing information policy

Critical unknowns include supply limits, required interfaces, load/current ratings, safety isolation, operating environment, board/mechanical constraints and any identity required to choose a safe active component. When these affect BOM correctness, the model returns `blocked` and questions. Non-critical procurement preference or optional alternate choices may remain `pending` with visible assumptions.

# Project isolation

Because the draft is stored in `ChatMessage`, it follows the existing per-project `projectChats` persistence. Switching projects restores the corresponding draft. Resetting chat removes only chat messages/drafts; accepted requirements, assets and confirmed components remain.
