# Changelog

All notable changes to overdb are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Fix it in overcli: a plan, or a statement in the slow-query pane, can be
  handed to overcli to find and fix the code behind it. The button glows
  when overcli is installed; without it, the same spot links to overcli.app
  (with a × to stop suggesting it). The first send asks
  which repo uses the database and remembers it on the env set (or the
  connection). The statement, plan and findings go; result rows never do.
- Schema drift can ignore tables by pattern (`tmp_*`, `*_bak*`), saved with
  the set. overdb suggests patterns from the scratch-looking names it finds,
  and only ever hides tables one side is missing.
- Tables only the baseline has are listed apart as not deployed yet instead
  of counted as breaking drift. Tick one to put it in the proposed SQL, or
  switch a set back to counting them.
- Schema drift has the set's Schema bar, and compares exactly the schema
  picked for each member, even when the names differ (`acme` locally,
  `acmeprod` on prod). Each member says which schemas it compared and how
  many tables the two have in common, so an empty result can be told apart
  from one that compared nothing.
- Schema drift keeps the last catalog it read from each connection, and
  compares against it when that connection cannot be reached — two
  environments on VPNs you cannot be on at once can still be compared. A
  member compared that way is marked with how old its catalog is. Catalogs
  only: no rows, nothing from the connection.
- Share a drift comparison. Export report… saves it as one HTML file anyone
  can open — the verdict, the consequence cards, every table side by side,
  what was not deployed or ignored, and the proposed SQL — with no script
  and nothing loaded from the network, in light or dark to match the
  reader. Copy as Markdown puts the same report on the clipboard for a PR,
  a ticket or a chat. Either one says when each catalog was read and which
  was kept rather than live. Schema, table and column names go in; hosts,
  users and rows never do.
- A set's Query tab knows which members can be reached before you press
  Run. With none reachable it says so — each server's reason in plain words
  and how old its kept catalog is — keeps the editor, turns Run off, and
  points to Schema drift, which works from kept catalogs. With some
  reachable, Run says "Run on 1 of 2", the others are skipped rather than
  failed, and the results say plainly when what came back is one server's
  answer and not a comparison. overdb checks again every twenty seconds
  while a member is down, and when the network or the window comes back.

### Changed
- Schema drift reads table by table. Findings are grouped by what they do —
  breaks, integrity, behaviour, performance, only on one side — each with a
  line on what that means, naming the servers. Every table that differs is
  on one scrolling page, as rows with the two servers side by side: the
  baseline, marked ★ and in teal, then the other member in orange, under
  column headings that stay on screen as you scroll. Only the words that
  differ are lit. Matching rows are folded (click to see the whole table),
  Swap sides puts the baseline on the right, and each table's SQL is a
  click away. A list down the side follows the scroll; ↑/↓ jump between
  tables. A set with one member to compare opens straight on it, the Schema
  bar marks the baseline and carries Re-read, and the ignore rules open
  from a button instead of taking a column.
- A set with more than one member to compare shows them side by side: a
  column per member beside the baseline's, each in its own colour, a cell
  reading "same" wherever a member agrees — so which of them drifted, and
  whether the same way, is one read. The member list turns columns on and
  off; up to three show at once. The side list marks which members differ
  on each table, each table has its SQL per member, and the report and
  Markdown export take the same shape.
- Changing one member's schema in a set's Schema bar moves the others that
  were on the same schema with it, when they have the new one too. A member
  deliberately on another name stays where it is, and a toast says who
  moved.
- Proposed SQL names the servers in its comments — "datetime on prod-west
  and timestamp on prod-east" — instead of "here" and "the baseline".
- Proposed SQL is dated as `2026-09-28 12:43 UTC` rather than a raw
  timestamp, and a foreign key to a table in the same schema no longer
  names the schema.
- A string default quoted on one server and not on the other (`'ACTIVE'`
  against `ACTIVE`) is no longer reported as drift.
- ⌘W closes the query tab you are on instead of the window, asking first if
  there is a query in it. Close Window moves to ⇧⌘W.

## [0.1.2] - 2026-09-27

### Added
- Import connections from DBeaver. overdb reads the `data-sources.json` in
  each DBeaver project and keeps its folders, and a connection DBeaver marks
  as production is filed as prod. Passwords stay in DBeaver, as they do for
  DataGrip: you enter them once per connection.
- A connection that fails to open now says why, above the editor, instead of
  a four-second toast with the driver's raw message. The banner names the
  likely fixes, and Fix connection… opens the connection with the same
  explanation and its fix buttons already showing.

### Changed
- The New and Edit connection sheet is regrouped into Connection, Sign-in
  and Security. TLS is a four-way switch with a line on what each mode
  checks, the SSH tunnel is a switch that expands in place, and the example
  URL matches the chosen engine. Test reports in the footer, with the
  server version and round-trip time, and a failure is explained just above
  the buttons. ⌘↵ saves.
- The Import connections sheet is wider, filters by name, host or
  environment, groups each source into a card with its own select-all, and
  shows each connection's engine the way the sidebar will.
- Building from source needs Node.js 22.12 or newer, and `npm run dev`
  builds the main process before it starts.

### Fixed
- The app icon broke up at small sizes. Finder's list view, the Dock at its
  smallest and the in-app mark below 64px now use a heavier cut of the
  platter-stack mark, and the dock icon gains the family's shade, rim and
  drop shadow.
- The Import connections sheet kept Cancel and Import below the list, out
  of sight once a machine turned up more than a handful of connections. The
  buttons now stay pinned while the list scrolls.
- The connection sheet's Test and Save buttons scrolled out of view the same
  way. They are pinned too.
- Form sheets showed a second scrollbar around their own.
- Changing a new connection's type turned on Verify full TLS even for
  localhost, so a stock local server failed on a certificate it never had.
- A connection set to a stored password with none saved was told to try a
  different password source. It now asks for the password again.
- Scanning a broad folder for JetBrains projects froze the whole app,
  queries in flight included, until the scan finished. The scan now runs
  in the background.

## [0.1.1] - 2026-09-23

### Added
- The app updates itself from GitHub Releases. It checks shortly after
  launch and every six hours, downloads in the background, and installs at
  the next quit; once the download is done, a prompt offers to restart now.
  It follows tagged releases only and never installs an older version.
  0.1.0 has no updater, so moving from 0.1.0 to 0.1.1 is a manual download;
  later releases arrive on their own.

### Fixed
- The plan comparison headline named a server by its connection id. It now
  uses the connection's name.

### Known gaps
- Nightly builds do not update themselves. They are unsigned on macOS and
  published under one moving `nightly` tag, so there is no feed for them yet.

## [0.1.0] - 2026-09-23

### Added
- Project scaffold: build config and CI/release workflows.
- Engine layer (`src/db`) with a `DbAdapter` seam and SQLite, Postgres, and
  MySQL/MariaDB adapters. SQLite runs on the runtime's own `node:sqlite`, so
  there is no native addon to rebuild, unpack, or sign.
- MySQL adapter verified against MariaDB 10.8.8: streaming pulls 5 rows from
  a 3.7M-row table for ~0.2 MB of heap, writes are rejected by the server
  with `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`, aliased columns keep
  their source table while expressions correctly report none, and
  `EXPLAIN FORMAT=JSON` works.
- Connection host (`src/dbhost`): one isolated process per open connection,
  with chunked result streaming under a two-chunk ack window.
- Query path end to end — editor, run/cancel, and a two-axis virtualized
  result grid with type-aware cells.
- Encrypted credential store (`safeStorage`), kept in a separate file from
  app state so `Store.load()` cannot carry a secret.
- Static guard tests: IPC contract, no-electron-in-the-engine-layer, and
  no-credential-returning-IPC-channel.
- Multiple result sets: statements are split by a comment- and literal-aware
  scanner and run in order, one result tab each, stopping at the first
  failure rather than half-applying a script.
- Schema-driven completion: tables and columns from the introspected
  catalog, column types shown inline, primary keys sorted first, and
  foreign-key-aware `join` suggestions that write the ON clause for you. No
  model involved — the catalog is exact and a model could only match it or
  hallucinate.
- Copy results: rectangular selection (click, shift-click, ⌘A), ⌘C for TSV,
  and a context menu offering TSV/CSV/JSON/INSERT/Markdown. Each format
  states what it does with NULL, since only JSON preserves it exactly.
- Connection editing, and more auth sources: keychain password, environment
  variable, 1Password reference (`op://`, resolved at connect time so the
  secret never enters overdb's store), or none for trust/socket auth.

- Its own logo: two stacked arcs — a rotated `) )`, which is also the
  silhouette of a database platter stack. Previously overdb shipped
  overgit's icon file verbatim, so the two were indistinguishable in the
  Dock.
- Schema/database switching from the query header. On MySQL these are
  databases (`USE`), on Postgres schemas in the connected database
  (`search_path`); the catalog is re-introspected on switch.
- Row selection via a row-number gutter, plus column sorting by clicking a
  header. Sorting re-asks the server rather than reordering the fetched
  page — sorting 1,000 of 3.7M rows locally and presenting it as "the top
  1,000" would be wrong in a way the user cannot see.

- **Ask panel** — a conversational AI surface over the connected database,
  running on whichever of `claude` / `codex` / `gemini` you already have
  logged in. overdb requires no separate API key. Three modes: Ask (prose
  questions about the schema), Write SQL (describe what you want), and Explain
  (runs a real EXPLAIN and interprets the plan). Prompts may include the
  question, conversation, schema metadata, SQL text, server errors, and plan
  statistics; result rows and bound values are not intentionally included.
  Nothing executes on its own: proposals land in the editor at your cursor,
  guarded by `aiNeverExecutes.test.ts`.
- **AI where the work is, not in a rail.** A failed query now offers the fix
  at the error: an unknown column is matched against the catalog and answered
  with no model at all (`id` -> `er_id` in one click), with an AI repair as
  the fallback for everything that isn't a misspelling. A query slower than
  the threshold offers "see why" in the status bar. Explain moved next to Run
  — it is an action on your query, not a conversation mode.
- Ask and Write SQL collapsed into one input. They differed only in prompt
  wording, so the mode picker was making the user do routing the tool should
  do itself.
- A fast-model tier for the calls that fire often (error repair), using each
  CLI's own `--model` flag rather than a second provider. Configurable in
  Settings; blank uses the CLI's default.
- Cross-schema completion: one cheap catalog query indexes every table in
  every visible schema, so `other_db.<tab>` resolves. Columns for the active
  schema are loaded eagerly; the rest stay names until you open them.
- A first run that explains itself. With no connections the main pane says
  what overdb is for and offers four ways in: servers already answering on
  this machine (one click fills the form), import from DataGrip, `.idea`,
  `~/.pgpass` or `DATABASE_URL`-style variables, a blank connection, and a
  sample. With connections but nothing selected it lists recent connections
  and sets instead.
- A sample database: one small shop in local, staging and prod as SQLite
  files under the app's data folder, gathered into an environment set with
  prod as the baseline. The three copies have drifted apart on purpose — a
  missing index and an old price on staging, a column and a table still in
  review on local — and the set offers starter statements that find them.
- Help: "How overdb works" (the four nouns, what keeps a connection safe,
  where things are, and which AI CLIs this machine has), "Keyboard
  shortcuts", and a fuller About. Reached from a new Help menu, the ? in the
  title bar, the command palette, and ⌘/.
- An application menu of overdb's own, in place of Electron's default whose
  Help linked to Electron. File holds new connection, import and new set;
  ⌘, opens Settings.
- A one-time suggestion, in the sidebar or on the start page, when two
  connections look like the same database in different environments — the
  same name once `staging`, `prod` and friends are taken out — with the set
  already filled in. "Not now" is per suggestion and sticks.
- The results pane before anything has run lists the four keys that get an
  answer, and says whether the connection is read-only.
- `OVERDB_PROFILE=<name> npm run dev` runs a dev build against its own data
  folder, so a first run can be tried without touching real connections.

### Fixed
- ⌘I did nothing, although the Ask button's tooltip has always offered it.
  It now opens and closes Ask, including from inside the editor.
- Row selection highlighted only the row number, not the row. Tailwind
  silently emits **no rule at all** for an opacity modifier applied to a
  colour defined as a bare `var(--x)`, and again for an off-scale value like
  `/28`. Colour tokens are now channel triplets declared as
  `rgb(var(--x) / <alpha-value>)`, and the built CSS is checked rather than
  assumed.
- Header and body columns could drift apart; both now share one flex layout
  (sticky gutter + relative cell canvas) instead of each computing its own
  gutter offset.
- overdb shipped overgit's icon file verbatim, so the two apps were
  indistinguishable in the Dock.
- The editor caret was near-invisible: CodeMirror styles built-ins like the
  cursor and selection layer for a light background unless the theme
  declares `dark: true`.
- Production builds now start from an empty `dist`, exclude tests, and fail if
  the distributable tree contains compiled tests or absolute user-home paths.
- Public documentation now states exactly what AI prompts contain and calls
  out DynamoDB's local read-only guard and IAM boundary.

### Changed
- Default row limit is 10,000, not 100,000. The first thing you do with a
  table is look at it; fetching 100k to scroll past 40 taxes every
  exploratory query.
- Softened the dark palette. Near-white text on near-black is the main
  source of strain in a dense grid, and full-strength rules on every cell
  edge made a wide table read as a wall of boxes.

### Known gaps
- The MySQL adapter is exercised against MariaDB 10.8; real MySQL 8 is
  untested. The two diverge on performance-schema views, which will matter
  for the query-performance work, not for querying.
- Windows builds are not code-signed yet, so SmartScreen may warn on first
  launch. macOS release builds are signed and notarized. Nightly builds are
  explicitly marked as unsigned prereleases.
- DynamoDB has no server-side read-only session. Use read-only IAM credentials
  for a durable production boundary.

[Unreleased]: https://github.com/overcodelions/overdb/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/overcodelions/overdb/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/overcodelions/overdb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/overcodelions/overdb/releases/tag/v0.1.0
