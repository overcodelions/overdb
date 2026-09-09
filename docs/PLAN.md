# overdb — a multi-environment database client

## Context

overcli and overgit both exist because a paid tool treated a plural problem as singular: overcli sits over many CLI agents, overgit over many repos. Database clients have the same blind spot — TablePlus, DataGrip, Postico, and DBeaver are all **one connection at a time**, while real work is the same logical database across local/staging/prod plus a half-dozen service DBs.

overdb is the third app in the family. It does **not** try to out-feature DataGrip on breadth (15 years of introspection engine, warehouse drivers, ORM integration — that fight is unwinnable by two people). It wins on four things the paid tools structurally don't do:

1. **Environments are first-class.** Run one query across local/staging/prod and diff the results. Detect schema drift between them. This is overgit's workspaces/worksets model transplanted, and it is what "better than what you pay for" actually means here.
2. **AI on your existing CLI auth.** overgit's `cli.ts` pattern — probe for `claude`/`codex`/`gemini`, spawn non-interactive, pipe to stdin. No API key, no subscription, no data leaving via overdb. TablePlus and DataGrip both gate AI behind their own billing.
3. **Performance intelligence that beats EXPLAIN.** Not a prettier plan tree — cross-environment plan divergence, regression tracking off `pg_stat_statements`, and prose explanations of *why* a plan went wrong.
4. **Safety as a feature.** Read-only by default; `prod` connections need an explicit arm-write gesture. AI-proposed SQL is never auto-executed — structurally, not by convention.

**Decisions locked by the user:** engines are Postgres + MySQL + SQLite (no Mongo, no warehouses); the wedge is multi-env connection groups; the app shell is **copied a third time** from overgit/overcli rather than extracted into a shared package.

---

## Architecture

Single package, no monorepo — same as overgit. Electron 41 + React 18 + Vite 6 + Tailwind 3 + Zustand 5 + TS 6, layout `src/{main,preload,renderer,shared}` plus two new top-level source dirs.

**Verified against the real runtime:** Electron 41.7.0 bundles Node 24.18.0 (module ABI 145), and `node:sqlite` is present, usable, and emits no experimental warning there. `stmt.columns()` returns per-column `{table, column, type}` — the source-table metadata inline editing needs — and `new DatabaseSync(p, {readOnly: true})` rejects writes at the engine level. Vite ports 5173 (overcli) and 5273 (overgit) are taken with `strictPort`; overdb uses **5373**.

### Two new source directories

**`src/db/` — the engine layer. Never imports `electron`.**
This single constraint is what makes `overdb serve --mcp` cheap later, and it's enforced from commit one by copying `overcli/src/cli/noElectron.test.ts` (retargeted at `src/db/index.ts`) *before* any CLI exists.

**`src/dbhost/` — one `utilityProcess` per open connection.**
Four reasons, in order: `node:sqlite` is synchronous and would freeze the window in-process; `child.kill()` gives universal cancellation even for SQLite, which has no interrupt handle; a 500k-row buffer lives outside the main heap so an OOM kills one connection rather than the app; and the CLI later forks the identical file with `child_process.fork`. `dbSupervisor.ts` is written against a `DbHostClient` interface with a `inProcessHost()` implementation so adapter tests never fork.

### Engine adapters

`DbAdapter` = `connect / ping / introspect / query / stream / cancel / explain / close`. Rows cross the wire as `Cell[][]`, never objects — column names ship once in `ColumnMeta[]`.

- **SQLite → `node:sqlite`.** Rejected `better-sqlite3`: overgit ships 6 artifacts across 3 OS × 2 arch, and a native addon means prebuilds for ABI 145 on every runner, `asarUnpack`, a separately-signed `.node` once notarization arrives, and Windows arm64 as the reliably-breaking link — a large recurring tax for opening a local file. Rejected `sql.js`: loads the whole DB into memory, so it cannot open a 4 GB file. Honest cost of `node:sqlite`: no `interrupt()`, so Cancel means killing the child and reconnecting (~1 ms), surfaced in the UI as "connection restarted."
- **Postgres → `pg` + `pg-cursor`** (explicit `cursor.read(n)` chunking). Pool of max 2: one carries the cursor, one is reserved for `SELECT pg_cancel_backend($1)` — you can't cancel a PG query on the connection running it.
- **MySQL → `mysql2/promise`**, `rowsAsArray: true`, second connection reserved for `KILL QUERY`.

**Turn the drivers' type parsing off.** Register identity parsers for PG oids 20, 114/3802, 1082/1083/1114/1184, 1700 (and `typeCast` for mysql2) so `timestamptz` and `numeric` arrive as the exact strings the server sent. By default `pg` converts `timestamptz` to a local-time JS `Date`, discarding the offset, and `numeric` to a lossy float. overdb decides presentation; the driver does not — and edits then round-trip byte-for-byte.

**Streaming:** 500-row chunks, adaptive down at 512 KB serialized, pushed as `main:event` on overgit's existing channel. Renderer `invoke`s `query:ack({runId, seq})`; the host won't send `seq+2` until `seq` is acked. Cells over 64 KB ship as `{__bin:true, b64, byteLength, truncated}` with on-demand full fetch. Default cap 100k rows with a visible "keep going?" — bounded, and we say so.

**Read-only is engine-level, not string-level:** PG `BEGIN READ ONLY` (server raises 25006), MySQL `START TRANSACTION READ ONLY`, SQLite `{readOnly: true}` (verified to throw). `src/shared/sqlGuard.ts` classifies statements for **UX only** — so the user sees "that's a write, arm it?" instead of a raw driver error — and its header must say so in the voice `secretScrub.ts` uses for "not a security boundary." Arming opens a *second*, short-lived, non-read-only connection for one statement; arms expire after 60 s or one statement, never persist, and `env: 'prod'` requires typing the connection name.

---

## The wedge: fan-out, diff, drift

Domain model maps one-to-one onto overgit's, which is the point — `Repo → Connection`, `Workspace → ConnectionGroup`, `Workset → EnvSet`, `preferredBranch → EnvSet.baselineId`. Everything is diffed against a baseline; an N×N matrix is unreadable, but "prod is the truth, staging drifted" is a sentence.

**Fan-out** (`src/db/fanout.ts`) is modeled directly on `worksetStatus` (`overgit/src/main/workset.ts:204`) and the `CheckoutOutcome` shape (`overgit/src/shared/types.ts:184`): attempt every member, report each outcome, never abort on the first failure. Reads fan out in parallel through the `pool()` helper copied from `workset.ts:174-192` at concurrency 4. **Writes fan out serially** — a direct lift of the reasoning in the `worksetCheckout` comment (`workset.ts:490`): if three of five fail in parallel, the user can't tell what order they happened in. A half-applied multi-env write is the worst thing this app could do.

**Result diff**, three tiers cheapest-first: a **scalar strip** when every member returns 1×1 (`select count(*)` across four envs — 30 lines of code and the v0.1 demo); a **shape diff** on `ColumnMeta[]` before touching rows; then **row diff** keyed by user-declared columns → PK inferred from `ColumnMeta.sourceTable` → whole-row hash fallback that reports only-in-A/only-in-B with no "changed" classification, and says so rather than guessing. Capped at 5000 rows, beyond which it offers aggregate diff (count/min/max/null-count per column), usually what people wanted across prod anyway.

**Schema drift** (`src/shared/schemaDiff.ts`) depends entirely on `schemaNormalize.ts` — without normalizing `varchar(255)` ≡ `character varying(255)`, `int4` ≡ `integer`, every PG-vs-PG diff is 40 false positives. `column-order` is its own low-severity class (MySQL cares, Postgres doesn't; flagging it at equal weight trains users to ignore the panel), and cross-engine drift is advisory-only. Surfaced like overgit's Landing Check: a sidebar verdict badge per EnvSet, a Drift tab grouped by table, TTL-cached with a `force`-flag Re-check reusing the `preflightMemo` LRU idiom at `workset.ts:230-275`.

---

## Performance intelligence

This is where overdb goes past DataGrip. DataGrip renders a plan tree and stops. Four layers, each building on the last:

1. **Plan capture.** `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)` / `EXPLAIN FORMAT=JSON` / `EXPLAIN QUERY PLAN`, normalized into a common `PlanNode` tree with estimated-vs-actual rows, loops, and buffer counts per node.
2. **Estimate-vs-actual as the primary visual.** Nodes are colored by the *ratio*, not by cost — the planner expecting 12 rows and getting 840k is the single most common cause of a bad plan, and it's the thing plan trees bury. Hot nodes surface stale stats, missing indexes, and bad correlation assumptions directly.
3. **Cross-environment plan divergence — the differentiator.** Same SQL, fanned out across the EnvSet, plans diffed structurally: "prod does a Seq Scan where staging does an Index Scan; `idx_orders_customer_created` is missing on prod" or "prod's `n_distinct` on `orders.status` is 4, staging's is 900 — stats are stale." No other client can do this because no other client holds three environments at once. Nearly free once fan-out exists.
4. **Regression tracking.** A background poller samples `pg_stat_statements` (and `performance_schema.events_statements_summary_by_digest` on MySQL) on an interval, storing deltas by query digest in a local append-only JSONL under `dataDir()`. Surfaces "this digest's mean time tripled since Tuesday," plus unused indexes from `pg_stat_user_indexes` and sequential-scan-heavy tables from `pg_stat_user_tables`. Requires the extension; when absent, the UI says exactly what to enable rather than degrading silently.

The AI layer then gets a genuinely rich prompt — plan tree with actuals, the table's row count and stats freshness, existing indexes, and the divergent plan from the other env — and returns prose: *"prod's planner expects 12 rows from `orders` but gets 840k; `last_analyze` is 11 days old. `ANALYZE orders;` first, and if that doesn't fix it, `(customer_id, created_at)` is the index staging has and prod doesn't."* Suggested DDL comes back as `ProposedSql` — insert-only, never run.

All monitoring queries hit catalog/stats views read-only, and remain read-only on `prod` regardless of arm state.

---

## AI layer

`src/main/ai.ts` copies `overgit/src/main/cli.ts`'s `probe()`, `runOneShot()`, `argsForTool()`, `extractCodexBody()`, and `stripFences()` **verbatim** — that code is already right — replacing only the prompt constants. 90 s hard timeout unchanged. If no CLI probes true, the whole AI surface hides (overgit's stated rule).

**Conversational, not one-shot.** The primary surface is an **Ask pane**: a threaded conversation scoped to a connection or EnvSet, rendering markdown prose the way overcli's chat does (lift `overcli/src/renderer/components/Markdown.tsx` — marked + DOMPurify + highlight.js). Multi-turn on top of one-shot spawns: main keeps the transcript and resends a compacted version each turn (older turns collapse to one-line summaries, the schema context block is sent once and re-sent only when the selection changes). That keeps overgit's stateless-spawn robustness — a wedged CLI costs one turn, not the session — at the price of re-sending tokens, which is the right trade when the user isn't paying per call. Turns carry ambient context: current connection + env, editor buffer, last result's column shape (**never its rows**), and the last captured plan.

Flows: `ask` (conversational), `nlToSql`, `explainPlan`, `perfAdvice`, `schemaQa`, `draftMigration`.

**Schema context selection** (`src/main/schemaContext.ts`) — a 900-table catalog is ~2 MB of DDL. Reuse the `SchemaSnapshot` drift already produced (never re-introspect for a prompt); compact each table to one line (`schema.table(col type, …) PK(…) FK(col→other.col)`); score by token overlap on snake/camel-split identifiers, **plus a one-FK-hop graph boost** from top hits (joins are the entire point of NL→SQL), plus identifiers already in the editor buffer, plus a session LRU; fill to a ~24 KB budget. Always include the engine version and `search_path` — dialect matters more to output quality than any individual table. Emit a `-- context:` header and show "used 11 of 340 tables" with an add-table picker, because the dominant failure mode is the right table not being in context, and it's otherwise invisible.

**Row data never enters a prompt** — identifiers, types, constraints, and plan statistics only. Enforced by `schemaContext.ts` taking a `SchemaSnapshot` and holding no adapter reference. Stated in the README next to overgit's "nothing leaves your machine" line.

**"Never auto-execute" is structural, three ways:** the execute channel's origin union is `'editor' | 'grid-edit' | 'saved'` with no `'ai'` member and no second execute channel (the copied `ipcContract.test.ts` proves handler set ≡ map set, so a smuggled one fails the build); AI returns a distinct `ProposedSql` type whose only consumer is `AiPanel`, which has an **Insert into editor** button and no Run; and `aiNeverExecutes.test.ts` asserts `ai.ts` contains no `ipcMain.handle` and imports nothing from `dbSupervisor` or `src/db`.

---

## Result grid

**Build it (~400 LOC) on `@tanstack/react-virtual` v3.** Rejected `ag-grid-community` (~400 KB, and its editing model wants to own the data, fighting staged edits), `@tanstack/react-table` (a client-side row model we don't need — sorting and filtering are server-side re-queries), `react-virtuoso` (proven in overcli's `ChatView.tsx`, but a variable-height *list* virtualizer with no column virtualization), and `glide-data-grid` (fastest, but canvas means no text selection, no accessibility tree, and no consuming `styles.css`'s CSS variables). Fixed 24 px rows are the easy virtualization case; we need both axes for a 120-column `select *`, which is two `useVirtualizer` calls.

Type-aware cells are where correctness lives: `NULL` as a dim chip, empty string as `''` in dim mono (**never a blank cell** — blank means "we rendered nothing" and the user must be able to tell), whitespace revealed as interpuncts on hover, JSON as a preview chip opening a CodeMirror side panel, binary as `<12.4 KB binary>` with a hex panel, `timestamptz` as **the server's exact ISO string** with local time only in a tooltip (silently localizing is the classic DB-client bug), `numeric` right-aligned as an exact string.

**Inline edits never write.** Editing stages a `PendingEdit`; a "Review N changes" bar opens a sheet showing generated parameterized SQL. Four guards: a cell is editable only when `sourceTable` is non-null, a PK is known, and every PK column is present in the result (otherwise read-only with the reason in a tooltip); the `WHERE` uses the full PK; a dry-run `SELECT count(*)` with the identical `WHERE` must return 1 before Apply enables; Apply goes through the armed-write gate.

---

## Credentials

Built on `overcli/src/main/hostElectron.ts` copied verbatim — `safeStorage` ciphertext into `overdb-secrets.json`, with the no-keychain fallback disclosed rather than silent. **Secrets never reach the renderer, five structural ways:**

1. `Connection` has no password field — only `secretRef: string`, a key. Nothing for a leak to leak.
2. **There is no getter channel.** `conn:setSecret` exists; no `getSecret` does. The renderer's relationship to secrets is write-only.
3. The store file is split: `overdb.json` (renderer-visible) vs `overdb-secrets.json` (main-only), so `Store.load()` physically cannot return one.
4. Resolution happens in `dbhost` — `credentials.ts` posts a `ConnectSpec` once over the utilityProcess port, never across `ipcMain`.
5. `secretScrub.ts` (copied) scrubs every driver error before logging, with each resolved password registered as a **known value** — that module's own header explains why: a DB password "has no recognisable shape, so no pattern set will ever find them." PG and MySQL both echo connection params into error text.

Guarded by `secretsNeverCrossIpc.test.ts`, a static check in the `ipcContract.test.ts` idiom: parse `IPCInvokeMap`, fail if any **return** type mentions `password|secret|token|connectionString|ConnectSpec`.

Importers (main-only, user-confirmed): `~/.pgpass` (**refuses non-0600**, exactly as libpq does), `DATABASE_URL`/`POSTGRES_URL`/`MYSQL_URL`, a user-picked `.env` (we never walk the filesystem hunting), and `op read` — which **stores the `op://` reference, not the value**, resolving at connect time. That last one is strictly better than copying a secret into our store and is a real differentiator.

---

## Files

Full scaffold below. `[copy: path]` means copy-with-rename — deliberate, not retyped.

**Root:** `package.json`, `tsconfig{,.main}.json`, `vite.config.ts` (port → 5373), `vitest.config.ts`, `tailwind.config.mjs`, `postcss.config.mjs`, OSS boilerplate, `.github/workflows/{ci,release,codeql,nightly}.yml` — all `[copy: overgit/*]` with `s/overgit/overdb/`, appId `com.overdb.app`. README/CHANGELOG new.

**`src/shared/`** — all `[new]`: `types.ts` (contains no secret field anywhere), `sqlGuard.ts` + test (comment/literal-stripping lexer; tests must cover data-modifying CTEs, `SELECT … FOR UPDATE`, dollar-quoting, MySQL backticks, `-- ;` inside comments), `schemaNormalize.ts` + test (highest-value pure module here), `schemaDiff.ts`, `resultDiff.ts`, `planNormalize.ts`, `connUrl.ts`, each with tests.

**`src/db/`** — `adapter.ts`, `adapters/{postgres,mysql,sqlite}.ts` + `.introspect.ts`, `fanout.ts`, `perfStats.ts` `[new]`; `pool.ts` `[copy: overgit/src/main/workset.ts:174-192]`; `noElectron.test.ts` `[copy: overcli/src/cli/noElectron.test.ts]`.

**`src/dbhost/`** — `index.ts`, `protocol.ts` + test `[new]`.

**`src/main/`** — `[copy]`: `index.ts` (BrowserWindow config and navigation lock at `overgit/src/main/index.ts:205` verbatim; all git IPC deleted), `store.ts` (128 LOC near-verbatim — keep the 250 ms debounce, tmp+rename atomic write, process-exit flush), `fs.ts` + test (keep `normalizeUnderRoot`/`realpathDeepestExisting`, drop `listRepoFiles`), `host.ts`/`hostElectron.ts`/`hostNode.ts` `[copy: overcli]`, `diagnostics.ts`, `secretScrub.ts`, `ipcContract.test.ts` `[copy: overcli]`, `ai.ts` `[copy: overgit/src/main/cli.ts]`. `[new]`: `dbSupervisor.ts` (the *only* file bridging electron ↔ `src/db`), `credentials.ts`, `credentialImport/{pgpass,envUrl,dotenv,onePassword}.ts`, `schemaContext.ts`, `schemaCache.ts`, `perfMonitor.ts`, `aiThread.ts`, `export.ts`, `secretsNeverCrossIpc.test.ts`, `aiNeverExecutes.test.ts`.

**`src/preload/index.ts`** `[copy: overgit]` — `window.overgit` → `window.overdb`.

**`src/renderer/`** — `[copy: overgit]`: `main.tsx`, `index.html`, `styles.css`, `global.d.ts`, `ErrorBoundary.tsx` (verbatim), `TitleBar.tsx`, `Explain.tsx` (verbatim — the learning bar now shows the literal SQL and session settings overdb will send, a better fit here than in overgit), `CommandPalette.tsx` and `Sheets.tsx` (shells verbatim, bodies new), `store.ts` (Sheet union, Toast, ConfirmRequest, stable-empty-array convention at lines 33-97 verbatim), `CodeMirrorEditor.tsx` (trim 17 language packs → `lang-sql` + `lang-json`). `useThemeEffect.ts` and `Markdown.tsx` `[copy: overcli]`. `[new]`: `App.tsx` (same 8-child shell as overgit's), `Sidebar.tsx`, `SchemaTree.tsx` (the `FileTree.tsx` buildTree/expanded-Set/filter idiom), `QueryPane.tsx`, `ResultGrid.tsx`, `Cell.tsx`, `ResultTabs.tsx`, `ScalarStrip.tsx`, `DiffView.tsx`, `DriftPanel.tsx`, `PlanView.tsx`, `PerfPanel.tsx`, `AskPane.tsx`.

**New dependencies, complete list:** `pg`, `pg-cursor`, `mysql2`, `@tanstack/react-virtual`. SQLite is built in; CodeMirror is already there and gets trimmed.

---

## Milestones

### v0.1 — one connection, one query, one grid, and the fan-out

1. **Shell.** Copy the skeleton, delete everything git-specific. A window with TitleBar, sidebar, SheetHost, CommandPalette, theme. Mostly a deletion exercise, and the fastest route to a running app.
2. **Contract.** Rewrite `shared/types.ts`, wire `store.ts` + preload, and get `ipcContract.test.ts` + `noElectron.test.ts` green **now**, while retrofitting them is trivial.
3. **SQLite end-to-end.** `dbhost` + `dbSupervisor` + `node:sqlite` streaming via `iterate()` + `setReturnArrays(true)`. Add-connection is a file picker.
4. **`ResultGrid.tsx`.** Both axes virtualized, NULL/empty-string/JSON/binary rendering. Read-only.
5. **Postgres.** `pg` + `pg-cursor`, identity type parsers, `BEGIN READ ONLY`, safeStorage store, `~/.pgpass` + `DATABASE_URL` import.
6. **The wedge.** Create an EnvSet from 2+ connections, run the buffer against all of them through `pool(4)`, render per-connection outcomes, a result tab per env, and the scalar strip.

**Cut from v0.1, explicitly:** MySQL (two engines proves the interface; the third is typing). Schema drift. Row-level diff — tabs plus the scalar strip are 80% of the value for 10% of the work. **The entire AI layer.** **Every write path without exception** — v0.1 is read-only, full stop, which is also the safest thing to ship first. Autocomplete, query history, file export, updater, CLI/MCP, `op read`, perf monitoring, SSH tunnels.

### v0.2 — the wedge, fully, and the conversation
MySQL. `SchemaSnapshot` + normalize + diff + Drift tab with baseline and Re-check. Row-level diff with PK inference. `sqlGuard` + armed writes + the second-connection write path. Inline edit → reviewable UPDATE. The AI layer: **AskPane** (conversational, markdown prose, compacted transcript) plus `nlToSql` and `schemaQa` on `schemaContext.ts`. Query history, saved queries, streamed export, `.env` + `op read`, `secretScrub` wired into every logging path.

### v0.3 — performance intelligence and headless
Plan capture + normalization, estimate-vs-actual plan view, **cross-env plan divergence**, `pg_stat_statements`/`performance_schema` polling with regression detection, unused-index and seq-scan reports, `perfAdvice` prose. Then `src/cli/` + `overdb serve --mcp` (`list_connections`, `describe_schema`, `query` — read-only, scoped to connections explicitly marked `mcpExposed`), `draftMigration`, drift → proposed DDL. Finally `electron-updater` + whatsNew + nightly copied from overcli, at which point adopting overcli's `hardenedRuntime` + `notarize` config is worth it — and costs nothing extra precisely because there's no native addon to sign.

---

## Verification

- **Static guards are the backbone** — `npm test` must keep four green from day one: `ipcContract.test.ts` (handlers ≡ map), `noElectron.test.ts` (`src/db` never reaches electron), `secretsNeverCrossIpc.test.ts` (no IPC return type mentions a secret), `aiNeverExecutes.test.ts` (no `'ai'` origin, no adapter import from `ai.ts`).
- **Pure-logic tests without a live DB** for `sqlGuard`, `schemaNormalize`, `schemaDiff`, `resultDiff`, `planNormalize`, `connUrl`, `fanout` (against a fake adapter), and adapter type-mapping.
- **Live-DB manual pass** via `docker run` Postgres and MySQL plus a local `.sqlite`: connect, introspect, stream a >200k-row result and confirm the renderer stays responsive and memory stays bounded; cancel a `pg_sleep(30)` mid-stream and confirm the connection survives; run an `UPDATE` unarmed and confirm the *server* rejects it (25006), not just the UI.
- **The wedge, end to end:** two Postgres containers with a deliberate schema difference — same `select count(*)` across both shows the scalar strip; the Drift tab names exactly the seeded difference and no false positives on `varchar` spelling.
- **Perf (v0.3):** seed one container with a missing index and stale stats, confirm the plan-divergence view names the right index and the AI prose cites estimate-vs-actual.
- **Run it:** `npm run dev` (Vite :5373 + Electron), or `npm run build && npm start`. The user runs the app.
