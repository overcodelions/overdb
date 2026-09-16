# Contributing to overdb

Thanks for your interest. overdb is small and opinionated; the bar for new behavior is "does it make working across environments clearer?". Bug fixes, polish, and well-scoped features are all welcome.

## Ground rules

- **`src/db/` must never import `electron`.** The engine layer runs under Electron, under the CLI, and under tests. `noElectron.test.ts` enforces this and will fail your PR.
- **Read-only is enforced by the server or driver wherever the engine supports it.** `sqlGuard.ts` exists to give a friendly "that's a write — arm it?" prompt, not to be a security boundary. DynamoDB is the explicit exception: it has no read-only session, so the adapter fails closed locally and a read-only IAM policy is the durable boundary.
- **Nothing executes SQL that the user didn't type or click.** AI output is a proposal that lands in the editor. There is no execute path from the AI layer, and a test asserts it.
- **Query results and bound values must never enter an AI prompt.** Prompts do intentionally include user questions, recent AI conversation, schema metadata, SQL text, server errors, and plan statistics. Do not broaden that set without updating `SECURITY.md` and the UI disclosure.
- New behavior needs a test. Pure logic (`src/shared/`) should be testable without a database.

## Getting set up

```bash
npm install
git config core.hooksPath .githooks
npm run dev          # Vite on :5373 + Electron
npm test             # vitest
```

The repository hooks reject private maintainer identities and commit-message
trailers before commit, then scan outgoing history again before push. CI
enforces the same policy.

For live-database work, `docker run` a Postgres and a MySQL rather than pointing tests at anything you care about.

## Commits and PRs

Conventional-commit prefixes (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`). Keep PRs scoped to one change; explain the *why* in the description, since the *what* is in the diff.

## Contribution terms

Small thing, stated once so it never has to be revisited.

By opening a pull request you confirm that:

1. **You wrote it, or you have the right to submit it.** This is the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).
   Sign your commits off with `git commit -s`.
2. **Your contribution is licensed to everyone under [Apache-2.0](LICENSE)**,
   the same terms as the rest of the project.
3. **You also grant Lionel Farr and Owen Farr a perpetual, worldwide, non-exclusive,
   irrevocable right to license your contribution under other terms** —
   a different open-source license, or a commercial one.

Point 3 exists so the project's license can change later without having to
track down every past contributor for permission. It does not take anything
away from you: you keep the copyright in your work, and everything you
contribute stays available to everyone under Apache-2.0, permanently.

## Trademarks

The code is Apache-2.0; the *name* and *logo* are not. Forks are welcome —
please give yours its own name. See [TRADEMARKS.md](TRADEMARKS.md).
