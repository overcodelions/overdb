# overdb

A database client built around one idea every other client misses: **you don't have a database, you have environments.** The same schema lives in local, staging, and prod, and the interesting questions are all comparisons across them.

Sibling project of [overcli](https://github.com/overcodelions/overcli) and [overgit](https://github.com/overcodelions/overgit).

## Why overdb

TablePlus, DataGrip, Postico, and DBeaver are all one connection at a time. If your work spans local + staging + prod, or a dozen service databases, you end up running the same query four times in four tabs and eyeballing the difference. overdb makes that comparison the primary gesture.

### Connection groups vs. environment sets

The two concepts are **orthogonal** — the same connection lives in both at once:

- **Connection group** — a durable grouping of connections. "These are Payments." Groups are the sidebar's collapsible sections and the target for bulk actions.
- **Environment set** — the same logical database across environments, pinned to a baseline. "orders-db across local, staging, and prod, where prod is the truth." Run one query against all members, diff the results, and see what's drifted.

### Four principles

1. **Environments, not connections.** Fan a query out across an env set and get a per-connection outcome for each — never an abort on the first failure. Diff results. Detect schema drift against a baseline.
2. **Overlay, not ownership.** Read-only by default. Enabling writes is per connection and persists, because "this is my local scratch database" is a durable fact rather than a mood — and turning it on for a `prod` connection asks you to type that connection's name, because the accident worth preventing is doing the right thing to the wrong server. Separately, a transaction is auto-commit or manual; manual holds one open across statements so a `DELETE` is reviewable before you commit, and rolls itself back after 90 seconds idle rather than leaving locks on a busy server. Read-only is enforced by the **server** (`BEGIN READ ONLY`, `START TRANSACTION READ ONLY`, SQLite's `readOnly` flag), not by parsing your SQL.
3. **AI in the loop, on your own auth.** Ask questions in prose. NL→SQL, schema Q&A, explain-this-plan, performance advice — piped to whichever of `claude` / `codex` / `gemini` you already have installed, using your existing login. No API key, no subscription. Only identifiers, types, and plan statistics ever enter a prompt — **never your rows**. AI-proposed SQL is never executed; it lands in the editor for you to read and run.
4. **Performance you can act on.** Not a prettier plan tree. Estimate-vs-actual as the primary signal, cross-environment plan divergence ("prod seq-scans where staging index-scans, and here's the missing index"), and what the server itself says it spends its time on.

## What's in it

Beyond the editor, the virtualized grid and the fan-out:

- **Schema drift.** Compare every member of an env set against its baseline, catalog to catalog, without running a statement. Findings are ranked *breaking* / *notable* / *quiet* — a missing column and a differently-spelled `varchar` are not the same news, and reported at the same volume the second kind buries the first. Proposed DDL to close the gap comes back as text; nothing destructive is ever generated as a runnable statement, and there is no Run button.
- **ER diagram.** The foreign-key graph, discovered from the constraints the server holds and never inferred from a column name. Opens focused on one table and its neighbourhood, because a 900-table diagram teaches nothing. Exports to SVG or PNG.
- **Charts.** Any result set as a line, bar, area or scatter plot. The axis and series are proposed from the column types rather than configured, a null is drawn as a gap and never as a zero, and a chart of a capped result says so.
- **Live health.** Sessions with what they're blocked on, connection headroom, cache hit ratio, rollback rate, table sizes, indexes the planner has never chosen. Every reading is nullable: what a server refused to tell us is listed as such rather than rendered as a zero. Cancelling someone's statement is the one action here, and it asks you to type the connection's name on `prod`.
- **ORM placeholders.** Paste a statement straight out of an ORM log — `WHERE client_name = ?`, `:clientName`, `#{clientName}` — and fill the holes in a bar under the editor rather than editing the SQL. Values are *bound*, never pasted into the statement, and they are remembered: each one has a default, an optional per-environment answer and an optional per-connection one, so the same query binds `hp` on staging and something else on prod. Run it on an env set and every member binds its own. A positional `?` is labelled from the column beside it, which is also what lets it share a saved value with the `:clientName` spelling of the same parameter.
- **History and saved queries.** Every statement you run, kept across restarts and rolled up per statement with a run count, searchable by text, connection or outcome. Name one and it becomes a saved query.
- **Slow queries.** What the *server* spends its time on across every client, from `pg_stat_statements` / `performance_schema` — with a since-you-opened-this-pane window, so you can watch a deploy land.

## Engines

Postgres, MySQL, SQLite, and DynamoDB. Deliberately not warehouses or document stores in general — a few engines done properly beats ten done shallowly. Postgres-compatible servers (Aurora, Redshift, CockroachDB, Timescale) are detected as *variants* and behave differently where they genuinely differ.

## Status

Pre-v0.1, building in the open. See the CHANGELOG for what is built and what is not.

## Stack

Electron + React + Tailwind + Vite + Zustand + TypeScript. Mirrors overgit's `src/{main,preload,renderer,shared}` layout, plus `src/db` (the engine layer, which never imports `electron`) and `src/dbhost` (one isolated process per open connection).

## Run it

```bash
npm install
npm run dev          # Vite on :5373 + Electron
# or
npm run build && npm start
```
