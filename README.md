# overdb

A database client built around one idea every other client misses: **you don't have a database, you have environments.** The same schema lives in local, staging, and prod, and the interesting questions are all comparisons across them.

Sibling project of [overcli](https://github.com/overcodelions/overcli) and [overgit](https://github.com/overcodelions/overgit).

## Why overdb

TablePlus, DataGrip, Postico, and DBeaver are all one connection at a time. If your work spans local + staging + prod, or a dozen service databases, you end up running the same query four times in four tabs and eyeballing the difference. overdb makes that comparison the primary gesture.

### Environment sets

An **environment set** is the same logical database across environments, pinned to a baseline: "orders-db across local, staging, and prod, where prod is the truth." Run one query against all members, compare each result with the baseline, and see what's drifted. The sidebar lists every connection by its environment tag — local, staging, prod — so the set and the servers in it are always one glance apart.

*Connection groups* ("these are Payments") exist in the data model but can't be created from the UI yet, and there are no bulk actions on them.

### Four principles

1. **Environments, not connections.** Fan a query out across an env set and get a per-connection outcome for each — never an abort on the first failure. Compare each result with the baseline: missing or extra columns, changed types, row counts, and whether the rows match. Detect schema drift against a baseline.
2. **Overlay, not ownership.** Read-only by default. Enabling writes is per connection and persists, because "this is my local scratch database" is a durable fact rather than a mood — and turning it on for a `prod` connection asks you to type that connection's name, because the accident worth preventing is doing the right thing to the wrong server. Separately, a transaction is auto-commit or manual; manual holds one open across statements so a `DELETE` is reviewable before you commit, and rolls itself back after 90 seconds idle rather than leaving locks on a busy server. Postgres, MySQL, and SQLite enforce read-only mode in the database or driver. DynamoDB has no equivalent session mode, so overdb fails closed using its local PartiQL classifier; use a read-only IAM policy as the durable boundary there.
3. **AI in the loop, on your own auth.** Ask questions in prose. NL→SQL, schema Q&A, explain-this-plan, performance advice — piped to whichever of `claude` / `codex` / `gemini` you already have installed, using your existing login. No separate API key is required by overdb. Prompts can contain your question, recent AI conversation, schema metadata, query text, server error text, and query-plan statistics. Result rows and bound parameter values are not intentionally included, but literals already written in SQL or echoed by an error are sent verbatim. Review sensitive SQL before invoking AI. AI-proposed SQL is never executed; it lands in the editor for you to read and run.
4. **Performance you can act on.** Not a prettier plan tree. The plan drawn as the work each step does — the planner's estimated rows with loops multiplied out, so the expensive step is a shape rather than a number to find. Cross-environment plan divergence ("prod reads all of orders, where staging narrows it with an index"), and what the server itself says it spends its time on. overdb runs a plain `EXPLAIN`: the counts are the planner's estimates, not measurements, and it never executes your query to profile it.

## What's in it

Beyond the editor, the virtualized grid and the fan-out:

- **Schema drift.** Compare every member of an env set against its baseline, catalog to catalog, without running a statement. Findings are ranked *breaking* / *notable* / *quiet* — a missing column and a differently-spelled `varchar` are not the same news, and reported at the same volume the second kind buries the first. Proposed DDL to close the gap comes back as text; nothing destructive is ever generated as a runnable statement, and there is no Run button.
- **ER diagram.** The foreign-key graph, from the constraints the server holds — plus, where a database map exists, the links the code uses that the schema never declared, drawn apart and each citing where it was found. Never guessed from a column name alone. Opens focused on one table and its neighbourhood, because a 900-table diagram teaches nothing. Exports to SVG or PNG.
- **Charts.** Any result set as a line, bar, area or scatter plot. The axis and series are proposed from the column types rather than configured, a null is drawn as a gap and never as a zero, and a chart of a capped result says so.
- **Live health.** Sessions with what they're blocked on, connection headroom, cache hit ratio, rollback rate, table sizes, indexes the planner has never chosen. Every reading is nullable: what a server refused to tell us is listed as such rather than rendered as a zero. Cancelling someone's statement is the one action here, and it asks you to type the connection's name on `prod`.
- **ORM placeholders.** Paste a statement straight out of an ORM log — `WHERE client_name = ?`, `:clientName`, `#{clientName}` — and fill the holes in a bar under the editor rather than editing the SQL. Values are *bound*, never pasted into the statement, and they are remembered: each one has a default, an optional per-environment answer and an optional per-connection one, so the same query binds `hp` on staging and something else on prod. Run it on an env set and every member binds its own. A positional `?` is labelled from the column beside it, which is also what lets it share a saved value with the `:clientName` spelling of the same parameter.
- **History and saved queries.** Every statement you run, kept across restarts and rolled up per statement with a run count, searchable by text, connection or outcome. Name one and it becomes a saved query.
- **Seed for a ticket.** Describe the data a ticket needs and get a plan in words, then the SQL, then a run inside a transaction you commit only after reading back what landed. With a linked repo it reads the code — read-only file tools, no shell — to seed values the app will actually accept. Local databases only, and a tunnelled "local" or a production-sized one is refused with no override.
- **Bases and branches.** Copy a database to this machine — your local one, or a sandbox or staging MySQL, MariaDB, Postgres or Redshift — as a *base*: a small copy that keeps only the tenants and logins you pick, still enough to log in and use the app. Then branch it, one writable clone per ticket or experiment, made in seconds whatever its size, and reset to the base when you are done. Each base has a proxy your services point at once; which branch they reach is a click in the title bar.
- **Database maps.** claude reads your linked repos — read-only tools, no shell — and records which tables the code uses together and how they join, including the links a schema never declares. Bases and seeds read the map instead of the code, so they are quick after the first time.
- **Slow queries.** What the *server* spends its time on across every client, from `pg_stat_statements` / `performance_schema` — with a since-you-opened-this-pane window, so you can watch a deploy land.
- **Agents, over MCP.** `overdb serve --mcp` hands an agent the connections you have already set up and tested — read-only, and only the ones you opted in. See below.

## Using it from an agent

`overdb serve --mcp` is the Overdb app started without a window, speaking MCP over stdio. An agent gets seven read-only tools: `describe_database`, `list_connections`, `query`, `list_tables`, `describe_table`, `show_sessions` and `list_slow_queries`.

Nothing is exposed until you say so. Open a connection, click its **Agents** chip (beside Writes), and turn it on; on a `prod` connection that asks you to type its name. **Agents** at the end of the bottom rail opens the Agents sheet: the command to register overdb with your client, ready to copy; which agents are connected now; every connection with its switch; and each call agents made — the tool, the connection, the statement and how it went, never the rows. A connection that is not opted in is not listed, and naming it gets the same answer as naming one that does not exist. Changes take effect on the next tool call — no restart.

Register it once with your agent. With Claude Code:

```bash
claude mcp add --scope user overdb -- /Applications/Overdb.app/Contents/MacOS/Overdb serve --mcp
```

On Windows and Linux, point at the installed `Overdb` executable the same way. From a checkout, `npm run build` and use `node_modules/.bin/electron /path/to/overdb serve --mcp`.

Then ask in prose — *"on shop-staging, which customers placed more than ten orders last week?"*, *"why is shop-prod slow right now?"* — and the agent lists the connections, reads the schema, and runs the reads it needs. An overcli worker gets the same thing by listing `overdb` among its MCP servers; every tool name reads as a read to overcli, so an unattended worker is not stopped for approval.

**What agents are told.** Column names are not enough to query a database well, so an agent also gets what overdb already knows about it. When it connects, the server's instructions give each database's tenancy rule and your notes, and tell it to call `describe_database` before writing SQL. That answers a question with the slice of the [database map](#whats-in-it) it touches — what each table is for, the values a status column takes, the links only the code makes, each with its `path:line` — and says when the map is older than the schema.

All of it can be changed under **What agents are told**, in the Agents sheet, beside a preview of exactly what an agent receives — as it connects, and from `describe_database` for a question you type:

- **Tenants:** optional, and silent unless you say so — most databases have none. Agents hear a tenancy rule only from your setting or your base recipe. When one table is clearly the hub (and isn't the users table), the editor suggests it for you to confirm or dismiss; agents never hear a guess. The rule names the column queries filter on (`client_id`), not the tenant's own key. Caveats adjust the rule where it is wrong for your database: tables every tenant shares (agents don't filter them), tenants to leave out unless asked (test and internal accounts), levels inside a tenant (`partner` within `client`), and more columns that mean the tenant. overdb suggests the shared tables and levels from the catalog.
- **Notes:** anything an agent should know — "amounts are in cents", "client 2 is a test account".
- **Map:** included when there is one; it can be left out.

On a connection in an environment set, the setting covers every environment in it. It is guidance, not a boundary: to keep tenants apart, give the agent a login that can only see one.

What an agent gets is what the app gets, minus everything that writes:

- **Read-only on the server.** Every session opens in the engine's read-only mode whatever *Writes* says for the connection, and a write, DDL or multi-statement batch is refused before it is sent. There is no transaction, cancel, kill or reset.
- **Your credentials, never theirs.** Passwords, 1Password, IAM tokens and SSH tunnels resolve inside overdb, exactly as when you connect; the agent sees a name, never a secret.
- **Bounded.** 100 rows by default, at most 1,000, with long cells cut; a 30-second statement timeout even on a local connection.

Read-only is not harmless. A read can still be expensive, and on Postgres a superuser's `SELECT pg_terminate_backend(…)` is a read. Expose a connection whose database user has only the rights you would give the agent.

### On a server

A hosted agent — an overgo worker, anything in a container — has no Overdb app, no keychain and no VPN of yours. For that there is the same server without the app:

```bash
node dist/mcp/headless.js --connections /etc/overdb/connections.json
```

Same six tools, same read-only rules (the code is shared), plain Node 22.12+, no Electron. It reads a connections file that holds **no secret** — each credential is a reference the server resolves from what it has itself:

```json
{ "version": 1, "connections": [
  { "id": "c1", "name": "shop-staging", "env": "staging", "engine": "postgres",
    "host": "shop-staging.xxxx.rds.amazonaws.com", "database": "shop", "user": "agents_ro", "ssl": "verify-full",
    "credential": { "source": "aws-iam" } },
  { "id": "c2", "name": "orders-prod", "env": "prod", "engine": "mysql",
    "host": "orders.internal", "database": "orders", "user": "agents_ro",
    "credential": { "source": "secret", "env": "OVERDB_ORDERS_PROD_PASSWORD" } }
] }
```

`aws-iam` signs an RDS or Redshift token with the server's own AWS role; `secret` reads the named environment variable, set on this process by whoever runs it; `none` is for DynamoDB, which uses the role directly. Saved credential commands, 1Password paths, SSH tunnels and certificate paths have no hosted form, on purpose — on a shared server a saved command would run as the server. A bad entry is skipped and logged; the rest are served. The file is re-read on every call.

Give it a database user made for agents, read-only by grant as well as by session, rather than a person's login.

You don't write that file by hand for a connection you already have. **Publish to your org's server…** in a connection's Agents menu shows the exact record that would leave your machine, lets you name the agents' login, and hands it to overcli (into `~/.overcli/inbox/connections/`), which publishes it to your org's server. A `prod` connection asks for its name first. The option appears once your overcli can take connections.

## Engines

Postgres, MySQL, SQLite, and DynamoDB. Deliberately not warehouses or document stores in general — four drivers done properly beat a long list done shallowly. On those four drivers overdb recognises ten servers — PostgreSQL, Redshift, Aurora PostgreSQL, CockroachDB, TimescaleDB, MySQL, MariaDB, Aurora MySQL, SQLite and DynamoDB — and detects which *variant* it is connected to, so each behaves differently where it genuinely differs.

## Status

Pre-1.0, building in the open. See the CHANGELOG for what is built and what is not.

## Stack

Electron + React + Tailwind + Vite + Zustand + TypeScript. Mirrors overgit's `src/{main,preload,renderer,shared}` layout, plus `src/db` (the engine layer, which never imports `electron`) and `src/dbhost` (one isolated process per open connection).

## First run

Open overdb with no connections and it offers four ways in: a server it found
answering on this machine, an import from DataGrip / IntelliJ / DBeaver / `~/.pgpass`,
a blank connection form (paste a URL and it fills itself), or **the sample** —
one small shop database in local, staging and prod, drifted apart on purpose,
as SQLite files that never leave your machine. The sample is the fastest way
to see what an environment set does.

Help → How overdb Works explains the vocabulary (connection, environment set,
baseline, group) and what keeps a connection safe; ⌘/ lists the keyboard
shortcuts. Both are in the command palette (⌘K) too.

## Run it

Requires Node.js 22.12 or newer. Released macOS builds are signed and notarized;
Windows builds are not signed yet, so SmartScreen may warn on first launch.
Released builds update themselves from GitHub Releases, from 0.1.1 on.

```bash
npm install
npm run dev          # Vite on :5373 + Electron
# or
npm run build && npm start
```

To see the first-run experience without touching your own connections, give
the dev build a data folder of its own:

```bash
OVERDB_PROFILE=fresh npm run dev
```
