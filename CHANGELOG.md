# Changelog

All notable changes to overdb are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Import connections from DBeaver. overdb reads the `data-sources.json` in
  each DBeaver project and keeps its folders, and a connection DBeaver marks
  as production is filed as prod. Passwords stay in DBeaver, as they do for
  DataGrip: you enter them once per connection.

### Fixed
- The app icon is legible at 16 and 32 pixels. Finder's list view and the
  sidebar mark now use a heavier drawing of the same three arcs, because the
  full-size strokes broke up at those sizes. The Dock icon gains a light
  shade, rim and drop shadow to sit with overcli and overgit.

### Fixed
- The app icon broke up at small sizes. Finder's list view, the Dock at its
  smallest and the in-app mark below 64px now use a heavier cut of the
  platter-stack mark, and the dock icon gains the family's shade, rim and
  drop shadow.
- The Import connections sheet kept Cancel and Import below the list, out
  of sight once a machine turned up more than a handful of connections. The
  buttons now stay pinned while the list scrolls.

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

[Unreleased]: https://github.com/overcodelions/overdb/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/overcodelions/overdb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/overcodelions/overdb/releases/tag/v0.1.0
