# Security Policy

## Reporting a vulnerability

If you find a security issue in overdb, please report it privately:

- **GitHub:** open a [private security advisory](https://github.com/overcodelions/overdb/security/advisories/new) on this repository.

Please include enough detail to reproduce. overdb is a desktop client that holds database credentials and connects directly to databases you point it at, so reports about **credential exfiltration**, **connections to unintended hosts**, **unintended writes to a read-only or unarmed connection**, path-escape, and command-injection are especially welcome.

We'll acknowledge within a few days and keep you posted while we work on a fix.

## Out of scope

- Bugs in `claude`, `codex`, `gemini`, `op`, or other third-party CLIs overdb shells out to — please report those upstream.
- Bugs in the `pg`, `mysql2`, or `node:sqlite` drivers themselves — likewise upstream.
- Issues that require an attacker to already have local code execution as the user running overdb.

## How overdb handles credentials

- Passwords are encrypted with the OS keychain via Electron's `safeStorage` and stored separately from the rest of the app state. Where no keychain is available the fallback is disclosed in the UI, not silent.
- **The renderer cannot read a secret.** There is a channel to set one and no channel to get one; a connection record holds a key, never a password. This is enforced by a test that fails the build if any IPC return type mentions a credential.
- Passwords are resolved in the isolated per-connection process and never cross the main IPC boundary.
- 1Password references (`op://…`) are stored as references and resolved at connect time, so the secret is never copied into overdb's store.
- Driver errors are scrubbed against known credential values before they are logged or shown, because Postgres and MySQL both echo connection parameters into error text.

## What overdb sends where

- Every query runs directly against the database you selected, from an isolated child process. No data leaves your machine through overdb itself.
- AI features pipe a prompt to whichever CLI you select, on stdin. That CLI inherits your shell environment (so any `*_API_KEY` / `*_TOKEN` vars in your shell are visible to it) and sends the prompt according to that tool's own terms and configuration.
- Prompts can include your question, recent AI conversation, schema identifiers/types/constraints, editor or failed SQL, server error text, and query-plan statistics. Query result rows and bound parameter values are not intentionally included. SQL literals and values echoed in server errors are not redacted, so review sensitive SQL before invoking an AI action.

## Read-only boundaries

- Postgres and MySQL use read-only transactions, and SQLite uses the driver's read-only mode.
- DynamoDB has no server-side read-only session. overdb blocks non-`SELECT` PartiQL locally and fails closed on unknown statements, but the durable protection is a read-only IAM policy on the credentials.
