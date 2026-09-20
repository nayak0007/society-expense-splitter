<!--
Keep this short enough that people actually fill it in. Sections that do not apply
should be deleted rather than filled with "N/A" — an empty template that is always
answered "N/A" trains reviewers to skim.
-->

## What and why

<!-- The "what" is in the diff. Spend the words on the "why": the problem, the
     constraint that forced this shape, and what you rejected. -->

## Roadmap task

<!-- e.g. T013. If there is no task, say which phase this belongs to and why it
     is being done now rather than later. -->

## Verification

<!-- Paste the commands you actually ran and their result. "It typechecks" is not
     evidence for anything that touches money, sync or RLS. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint && pnpm exec eslint . && pnpm lint:arch`
- [ ] `pnpm test`
- [ ] `pnpm build` (if the change affects what ships)

## Checklist

- [ ] Commit messages are Conventional Commits (`feat(scope): …`)
- [ ] No secrets, keys, tokens or real user data in the diff
- [ ] New environment variables are in `.env.example` **and** the Zod schema in
      `apps/api/src/config/validation.schema.ts`
- [ ] Money is integer paise, suffixed `*Paise`, with no floating-point arithmetic
- [ ] New tenant-scoped tables have `ENABLE` **and** `FORCE` row level security,
      and a test proving one society cannot read another's rows
- [ ] New API routes appear in the generated `docs/api/OPENAPI.yaml`
- [ ] `packages/domain` and `packages/application` still have no framework imports
      (enforced by `pnpm lint:arch`, stated here so it is a conscious choice)

## Migration

<!-- Delete if none. Every migration must be backward-compatible with the
     currently running version (expand → migrate → contract), because deploy
     order is not guaranteed during a blue-green shift. -->

- [ ] Backward-compatible with the running release
- [ ] Rollback path stated

## Risk

<!-- What breaks if this is wrong, how you would notice, and how you would undo it.
     "Low" is an acceptable answer. Leaving this blank is not. -->
