# AI Development Instructions

**Product identity:** the user-facing product is **Resident 360** (Expo slug `resident-360`, deep-link scheme `resident360://`). **`@ses` is a historical/internal package namespace and does not represent the user-facing product name** — the same applies to the `ses` local database, the `ses_meta` migrations ledger, the `ses/*` persisted storage keys, and the `SES-` ticket prefix in branch/TODO conventions. Do not rename these as part of brand work; "society" remains the domain concept the product manages.

Before implementing any task:

1. Read docs/Architecture.md
2. Read docs/PRD.md
3. Read docs/Roadmap.md

Rules:

- Never modify unrelated files.
- Never delete existing functionality.
- Build only the requested task.
- Keep components under 250 lines where practical.
- Use TypeScript strict mode.
- Follow Clean Architecture.
- Prefer reusable components over duplication.
- Explain major architectural decisions before implementing them.
- Ask for confirmation before making large refactors or changing project structure.
