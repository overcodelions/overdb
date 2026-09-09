# Contributing to overdb

Thanks for your interest. overdb is small and opinionated; the bar for new behavior is "does it make working across environments clearer?". Bug fixes, polish, and well-scoped features are all welcome.

## Ground rules

- **`src/db/` must never import `electron`.** The engine layer runs under Electron, under the CLI, and under tests. `noElectron.test.ts` enforces this and will fail your PR.
- **Read-only is enforced by the server, never by parsing SQL.** `sqlGuard.ts` exists to give a friendly "that's a write — arm it?" prompt, not to be a security boundary. Don't let it become one.
- **Nothing executes SQL that the user didn't type or click.** AI output is a proposal that lands in the editor. There is no execute path from the AI layer, and a test asserts it.
- **Row data never enters an AI prompt.** Identifiers, types, constraints, and plan statistics only.
- New behavior needs a test. Pure logic (`src/shared/`) should be testable without a database.

## Getting set up

```bash
npm install
npm run dev          # Vite on :5373 + Electron
npm test             # vitest
```

For live-database work, `docker run` a Postgres and a MySQL rather than pointing tests at anything you care about.

## Commits and PRs

Conventional-commit prefixes (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`). Keep PRs scoped to one change; explain the *why* in the description, since the *what* is in the diff.
