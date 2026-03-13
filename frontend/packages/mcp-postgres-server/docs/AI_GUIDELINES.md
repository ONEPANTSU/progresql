# AI Collaboration Guidelines

## How humans express requirements
- Provide behavior-first acceptance criteria (BDD scenarios).
- Specify safety constraints explicitly (no data access, no DML/DDL).
- Supply environment details (PostgreSQL DSN) for integration tests.

## How this project implements BDD
- Features in `features/*.feature` describe expected behavior.
- Step definitions in `tests/` bind Gherkin to executable pytest-bdd tests.
- Code changes must follow the order: **feature → test → implementation**.

## Cursor / LLM workflow
- Read the relevant feature before coding.
- Add or update tests to express the behavior.
- Implement the minimal code to satisfy tests; avoid speculative features.
- Keep changes small and focused; prefer incremental commits.

## Safety and SQL handling
- Never issue arbitrary SQL; only metadata queries and safe EXPLAIN paths are allowed.
- Reject `SELECT *`, DML/DDL, multi-statements, and EXPLAIN options.
- Use read-only connections (`default_transaction_read_only=on`).

