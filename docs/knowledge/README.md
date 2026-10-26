# Knowledge and RAG

The Runtime can index Markdown documents and structured rule entries to help
retrieve PCB design guidance. In this public repository only generic,
non-customer documentation is shipped.

## Layout

- `docs/knowledge/` — documents eligible for local RAG indexing.
- `runtime/knowledge.mjs`, `runtime/rag/` — store and retrieval implementation.

## Not shipped

The internal dataset (rules/failure cases derived from private projects) and
customer-specific design files are not part of this repository. If you add
your own corpus, keep provenance and licenses per entry; do not commit
confidential designs.
