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
2. **Overlay, not ownership.** Read-only by default. A connection marked `prod` requires an explicit *arm write* before anything mutating runs, and arming is one statement, 60 seconds, never persisted. Read-only is enforced by the **server** (`BEGIN READ ONLY`, `START TRANSACTION READ ONLY`, SQLite's `readOnly` flag), not by parsing your SQL.
3. **AI in the loop, on your own auth.** Ask questions in prose. NL→SQL, schema Q&A, explain-this-plan, performance advice — piped to whichever of `claude` / `codex` / `gemini` you already have installed, using your existing login. No API key, no subscription. Only identifiers, types, and plan statistics ever enter a prompt — **never your rows**. AI-proposed SQL is never executed; it lands in the editor for you to read and run.
4. **Performance you can act on.** Not a prettier plan tree. Estimate-vs-actual as the primary signal, cross-environment plan divergence ("prod seq-scans where staging index-scans, and here's the missing index"), and regression tracking off `pg_stat_statements`.

## Engines

Postgres, MySQL, SQLite. Deliberately not warehouses or document stores — three engines done properly beats ten done shallowly.

## Status

Pre-v0.1, building in the open. See [docs/PLAN.md](docs/PLAN.md) for the full design and milestones.

## Stack

Electron + React + Tailwind + Vite + Zustand + TypeScript. Mirrors overgit's `src/{main,preload,renderer,shared}` layout, plus `src/db` (the engine layer, which never imports `electron`) and `src/dbhost` (one isolated process per open connection).

## Run it

```bash
npm install
npm run dev          # Vite on :5373 + Electron
# or
npm run build && npm start
```
