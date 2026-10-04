# Changelog

All notable changes to overdb are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-04

### Added
- The Services switch in the title bar shows every base's proxy at once —
  a branch by name, a base on its own server dimmed — and What services
  see stays one connection under its base as you switch, its own server
  included.
- Reset a branch to its base: its changes thrown away and its data taken
  again from the base, in seconds, keeping its name, port and connection so
  nothing pointed at it changes. After a base is rebuilt, each older branch
  says "base is newer" and its Reset takes the fresh data. In the branch's
  ⋯ menu in the sidebar, and in Branches.
- What a branch is, where the question comes up: an ⓘ beside Branches in
  the sidebar, the same words when there are none yet, and a Branches per
  ticket section in How overdb works with the picture — server, base,
  branches, and the proxy your services keep.
- Seed for a ticket. Describe the data a ticket needs — or paste the ticket —
  and overdb investigates, proposes a plan in plain words, writes the SQL,
  and runs it in a transaction you commit or roll back after reading back
  what landed. With a linked repo and `claude`, the investigation reads the
  code to learn what the schema can't say (allowed status values, JSON
  shapes, app rules), using Read, Grep and Glob only: no shell, no MCP
  servers, and `.env` files denied. Local databases only — tagged local,
  writes on, and on this machine: no tunnel, and the port held by a
  database server or Docker rather than ssh, kubectl or a cloud SQL proxy
  (when the owner can't be seen, a table over a million rows refuses it
  instead). No override. The script is checked before you see it: INSERTs only, every
  table and column real, parents before children, and a teardown that
  deletes exactly what the seed made. Commit saves both as saved queries.
  From the Seed button on a local connection, or ⌘K.
- Create a base: the first half of giving each ticket its own database
  (docs/design/baselines.md). On a local connection, overdb reads every
  schema's catalog and table sizes, finds the tenant — the table most
  others point at, by foreign key or by a column named for its key — and
  asks which tenant and which logins you work with, in your words. It
  searches every table that keeps logins, not just `users`, and says what
  it finds: a login in a second users table, an admin on another account,
  an inactive lookalike. Then it sorts every table — only rows for your
  starting points, copy whole, start empty (logs, queues), leave out
  (backups, scratch copies), schema only — with a reason and a size
  estimate, and lists the links it guessed from column names so you can
  turn any off. They choose rows only and are never drawn as foreign keys.
  Choose which schemas the base holds. Tenancy has levels — overdb
  finds them the way it finds the tenant (`partner` within `client`) — and
  any level can be narrowed to some of its rows, by name or to the ones your
  logins belong to: what carries a `partner_id` then keeps only those
  partners', plus the client's own rows that belong to no partner. A login
  table keeps your logins and every row the client would keep anyway. The
  size estimate counts the chosen tenant's real share of one large table
  rather than assuming an average one.
  The recipe saves to `.overdb/baseline.json` in the linked repo. With a
  linked repo and `claude`, Check with the code reads it (Read, Grep and
  Glob only) for what the schema can't say — how a second users table
  reaches an account, which of two tables a column means, which emptied
  table logging in needs — and each suggestion is applied by hand. From the
  more menu on a local connection, or ⌘K.
- Build a base (MySQL). overdb starts its own `mysqld` from the one on
  this machine (`--no-defaults`, its own directory, port and socket — your
  server and its my.cnf are never touched), and a builder process copies
  the recipe into it: every schema and table, the starting points' rows and
  everything tied to them, small tables whole, missing parents fetched so
  no real foreign key points at nothing, then views, routines, triggers and
  the accounts your services connect as. Then it stops the instance; its
  data directory is the base. On a real 11 GB database: 773 tables and
  754k rows in under 20 seconds.
- Branches. A branch is a clone of the base (copy-on-write
  on APFS, so instant and nearly free), running on its own port, with its
  own connection in the sidebar — seed it with Seed for a ticket, break it,
  delete it. The proxy listens where your services already connect (a TCP
  port and, for MySQL, the Unix socket) and forwards byte for byte to your
  own server or any branch; switching closes the connections it
  carries so each service's pool reconnects to the new one. Loopback only.
  Two ways to point services at it: a spare port (3310 by default) that
  each service is pointed at once, leaving your own server where it is —
  the recommended path — or taking over 3306 and `/tmp/mysql.sock`, which
  needs your own server moved once (overdb shows the lines to add and never
  edits another program's config). A port that is taken says who holds it.
  Keep running when overdb is closed moves the proxy and the branches into a
  small background helper — a LaunchAgent running overdb's own binary as
  node, started at login, removable from the same panel — and taking over
  3306 requires it, so quitting overdb can never leave services with no
  database. Without it, quitting asks first when services may be using the
  proxy or a branch. In the sidebar, branches nest under the connection
  they were made from — each with its status, a SERVICES badge on the one
  your services reach, Seed and a menu on hover — with the base and
  Rebuild below them. The Services switch in the title bar ("Services → PROJ-123") picks
  where services go in one click, or ⌥⌘0 (your server) and ⌥⌘1–9 (branches);
  it moves your services only, never what a tab queries. While the
  proxy runs, What services see under the branches is a read-only
  connection to query exactly that — renamed and reconnected when you
  switch, gone when it is off. Every branch has a How to
  connect guide built from its own address: use it in overdb, point one
  service at it (`.env`, JDBC/Spring, the mysql client — the password is
  never shown), point every service at it through the proxy, and go back.
- Repos know their schemas. An env set (or a connection in no set) links
  any number of repos, and each says which schemas its code uses — overdb
  suggests them by scanning the repo for datasource config and
  `schema.table` names (names and counts only; `.env`, keys and dependency
  folders are never opened), and you confirm. Reading the code for a seed or
  a base reads the repos for the schemas in play, each told which schemas
  it owns, rather than whichever repo was linked first; extra repos are
  added with their secrets denied the same way. Branches and What services
  see use the repos of the connection they came from. A base recipe saves
  in the repo you mark for it. Linking a repo from Seed or the base adds
  to the list instead of replacing it; the set's edit sheet shows them all.
- Database maps. Map this database (on the Seed screen, or in an env set's
  edit sheet) reads each linked repo once — read-only, the same limits as
  every code reading — and writes down what only the code knows about each
  table: what a row is, which repo and module own it, the values its status
  and type columns take, the shape of its JSON, the rules the app enforces,
  and the links the code makes that no foreign key does, across schemas,
  each with a path:line. Every name is checked against the real catalog and
  invented ones are left out. Big catalogs are mapped in parts of 50 tables,
  three passes at a time, saved as each finishes. A seed then plans from the
  slice of the map its ticket touches, in one call, without reading the
  code; the map also suggests which schemas a ticket is about. Reading the
  code is still there (Also read the code now), and what it finds is added
  to the map for the next seed. The map records each repo's commit and a
  fingerprint of each schema, says when it is behind ("3 commits ahead",
  "orders changed"), and Refresh re-reads only the files git says changed.
  Kept in overdb's own folder by default; Settings › Database maps can keep
  it in the recipe repo's `.overdb/map/` to share it through git.
- A seed can cover more than one schema. It starts from the schema the tab
  is on, suggests others from the ticket's own words (a ticket about
  learners suggests the learning schema), and any can be added; their
  tables join the plan schema-qualified, after the tab's own. Reading the
  code for a seed reads every linked repo, the ones for its schemas first.
- Seed on What services see seeds what it points at — the branch your
  services use, or your own server — instead of refusing a read-only
  connection. A stopped branch offers to start instead of reporting a
  refused connection.
- The sidebar asks where, then what: an environment switch at the top (All,
  Local, Sandbox, Staging, Prod — whichever you have, remembered), and
  environment sets as the groups below it, each with the connections it has
  in that environment and Compare to open the set across all of them.
  Connections in no set are listed after. Search looks across every
  environment. Starring floats a row to the top of its group, and the star
  by the search box shows only starred ones — there is no Pinned section
  repeating them. Opening a connection the tab hides moves to its
  environment.
- SQLite reports how many rows a write changed, so an INSERT says
  "3 rows inserted" instead of nothing.
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
- Copy a shared server to this machine. A base can now be made from a
  shared dev, sandbox or staging MySQL server, not only your own: "Copy
  to this machine…" on its ⋯ menu, ⌘K, a set's Compare page, the Branches
  sheet, and the Writes panel when writes go on for one. overdb reads it —
  through its SSH tunnel and over its TLS, and only ever reads — and builds
  a small copy here on a server of the same kind (MySQL for MySQL, MariaDB
  for MariaDB). When this machine has none, the sheet says so from the
  first step and installs it with Homebrew at a click; nothing is run as a
  service. Branches clone it as they do any base. Never from production,
  and never from an untagged server: there is no override.
- Copy Postgres and Redshift to this machine. A Postgres server is
  copied into a local Postgres; Redshift, which has no local edition, into
  Postgres too — its distribution and sort keys and encodings left behind,
  IDENTITY made an identity column, SUPER made jsonb, its clock functions
  made now(). The same plan as a MySQL base: starting points, rows
  following their parents, missing parents fetched, then keys, indexes,
  foreign keys (NOT VALID) and views, with any the copy refuses listed.
  Redshift's table sizes are read from svv_table_info. Postgres installs
  from the copy sheet like MySQL does.
- "Copy another server here" lists every connection that could be copied,
  and the ones that cannot yet say why, rather than leaving them out.
- A proxy per base. Each base has its own address for its services, so a
  service that uses two databases is switched in two places — with no
  branch chosen, a shared server's proxy forwards to that server itself.
  The title bar's switch lists each base with its branches; ⌥⌘1–9 pick a
  branch and move only its base's proxy, ⌥⌘0 sends every one back. The
  proxy set up before moves onto the first base, as it was. A proxy for a
  production connection is refused, and two cannot share a port.

- A base build or a copy can keep going in the background. The sheet's
  "Keep going in the background" closes it without stopping anything, and
  a small panel at the bottom of the window follows the build — its step,
  how long it has run, Stop — then offers to make a branch when it lands,
  or the log when it fails. Starting the same one twice is refused.
- Right-click a connection in the sidebar for what you can do with it:
  open it or a new tab, seed it, create a base or copy it to this machine,
  its branches and map, star, edit, duplicate or delete. Sets in the dock
  have their own: compare, star, edit, delete. The menu opens at the
  pointer and stays inside the window.

### Changed
- The sidebar lists every connection under its environment, whether or
  not a set holds it, so a local database is under Local rather than only
  inside the sets it belongs to. Sets moved to a dock below the list: one
  row each, dots for the environments it spans, and Compare. Under an
  environment tab, sets with nothing there fade rather than disappear.
- Mapping a database is much faster. A quick scan, with no AI, first finds
  which files name each table (as written, or as the class an ORM maps to
  it). Tables no file names are left out, and each pass is handed the files
  for its tables instead of searching the whole repo; tables that live in
  the same part of the code share a pass. The schema the connection uses is
  mapped first, and the card says when seeds can use the map while the rest
  carries on. "Map them too" asks about the left-out tables later.
- The database map has its own pane, Map, in the bottom rail beside
  Diagram: the repos it reads (linked and changed there), whether it is up
  to date, and every mapped table — its purpose, where its code lives, the
  values its columns take, JSON shapes, rules and links, each cited to a
  line. Seed, Create a base and a set's form show one line for the map and
  the repos, with the way to the pane.
- Mapping uses the standard model, `sonnet`, rather than the everyday one.
  Settings has a Map model field to change it. Five passes run at once,
  up from three, and the Map pane says up front that a first map takes
  from a few minutes to about 20 for a large database. Each map keeps a
  record of its last run — what each repo's scan found and how long each
  pass took.
- A base settles its links from the map before asking anyone. A guess the
  code agrees with is confirmed, one the code points elsewhere is
  corrected, and links the column names never suggested are added — each
  citing where in the code. The tenant and its levels are found with those
  links too, and the links to check shrink to what the map could not say.
- The diagram draws the map's links from the code alongside foreign keys:
  dashed, in the AI colour, with what the code does and where on hover. A
  switch turns them off.
- Linking repos takes several at once: the folder picker allows more than
  one (hold ⌘), and each repo's schemas are suggested together.

### Security
- A base's server has a password. Its root (or `postgres`) account gets a
  random one, kept in the system keychain, as the build's last step — or
  yours, when you connect as that account — and a Postgres copy takes
  password logins only. Until now any program on this machine could log in
  to a running base or branch as its superuser and read the account hashes
  it keeps for your services. Rebuild a base built before this to get it,
  then reset its branches.
- A base or branch server reads and writes no files from SQL
  (`--secure-file-priv` on an empty directory), and a copied view whose
  definition holds a second statement, or a column type that is not a type
  name, is never run on the copy.
- The proxy only takes a socket path in the temporary directory, removes
  only a socket to take it, and checks the port and server it is given,
  whether from the window or the background helper's socket — which is now
  private from the moment it is created.
- What services see keeps a server's "Verify full" certificate check
  through the proxy, against the server's own name.
- Password hashes printed as hex are kept out of build logs, as are any in
  a skipped statement's error.
- Stopping a leftover server only ever stops a MySQL, MariaDB or Postgres
  server whose data directory is exactly the one being replaced.

### Fixed
- A branch or base server left running by an earlier overdb is stopped
  before its data is replaced or it is started again. A reset no longer
  swaps files under a live server and goes on answering from the old data.
- A base keeps the parent rows its kept rows name in columns the schema
  never declared — a login's company, a deal's partner — not only those
  behind real foreign keys.
- A column holding another system's id (`remote_client_id`,
  `crm_account_id`, `external_user_id`) is no longer read as a link to a
  table here, so it no longer scopes a table by the wrong key.
- A table you start from is no longer set aside for being empty: in a data
  mart the tenant table can be empty while every table pointing at it holds
  the tenant's rows.
- Postgres and Redshift requests on one connection run one at a time.
  Each runs in its own read-only transaction and a connection has one, so
  two at once — discovery and the schema tree — interleaved, and one
  refused statement failed the other with "current transaction is
  aborted". Cancel, acks and close still go straight through. Discovery
  also asks whether it may read a table before reading it.
- The client search says where it looked, and "Look in another table"
  searches any table or view you choose.
- Links are found in a database that declares no keys — every Redshift
  table, most data marts. A table's own `<table>_id` column, or a bare
  `id`, is read as its key, so `client_id` and `partner_id` columns link to
  `client` and `partner` and the tenant is found from them.
- Finding the client you work in looks past the tenant's own table: when
  it has no match, every other table keyed the same way is searched — a
  data mart mirrors one client into several, like `acme_db_client` — and
  each hit says which table it came from. A table is also keyed by the end
  of its name (`acme_db_client.client_id`). Two levels of the same name
  show their schema, and a server that gives no sizes shows "—", not 0 B.
  Views are searched too, closest name first; results appear as each
  table answers, grouped under the table they came from, tables with an
  exact match on top, with a line saying which table is being read. And a table that follows a starting point follows the keys
  you picked even when that row is not in the starting table itself, so a
  client found in a mirror still scopes everything that carries its id.
- A Postgres or Redshift database keeps its own recipe in the repo
  (`.overdb/baseline-redshift-<database>.json`) instead of picking up the
  MySQL one beside it, and a recipe whose engine or tenant does not match
  the database is set aside with a note rather than applied.
- A Postgres or Redshift statement that failed while overdb read the
  catalog no longer leaves the connection broken. The read-only
  transaction it ran in was left open and aborted, and everything after it
  failed with "current transaction is aborted" until reconnecting.
- Discovering a Redshift base works for a user without rights to
  svv_table_info: sizes fall back to pg_class, and a table with no estimate
  is counted. A table whose size is still unknown is no longer copied
  whole as if it were small — it is left for you to decide.
- A copy of an RDS or Aurora server creates every table the server has.
  Those run with InnoDB's strict mode off, so a COMPACT table whose widest
  row would pass 8 KB exists there but is refused by a local server's
  default ("Row size too large"). The build now matches the server's strict
  mode and default row format, as it already matched its sql_mode, and
  says so in the log.
- A base and its branches keep the server's settings across restarts.
  overdb starts its servers with `--no-defaults`, which also skips what
  `SET PERSIST` saved, so sql_mode was lost on every start; the settings
  are now kept with the base and passed each time it or a branch starts.
- A base built from MariaDB copies JSON columns. MariaDB keeps JSON as
  text flagged as JSON, which the driver parsed into objects and wrote back
  as `'[object Object]'` lists ("Operand should contain 1 column(s)"); the
  builder now reads JSON as text, as it does for MySQL's own JSON type. A
  table whose rows cannot be copied is named in the report and the build
  carries on.
- A base build that cannot fetch the parent rows for one foreign key
  names it under what could not be recreated and carries on, instead of
  stopping the whole build. Every build writes a log (in overdb's
  `instances/logs`, the last 20 kept) with each step, the plan's size and,
  when it fails, the error, the statement the server refused (passwords
  masked) and the server's own last log lines; a failed build has a Show
  the log button.
- The links a base settled from the database map are saved in its recipe,
  so the build follows the same links that were reviewed.
- Building a base from a MariaDB server works. MariaDB's mysqld has no
  `--initialize`, so its data directory is made with `mariadb-install-db`
  (root with an empty password, like MySQL's), and it is started without
  the MySQL-only X Plugin and binlog switches it refuses.
- The editor header is sorted by what each control is. Where you are and
  what state it's in sit on the left: the connection, the schema, one chip
  for writes and the transaction mode (click it to change either, or which
  tables the AI always sees), and the table count, which opens the table
  browser. An open transaction takes the chip's place with its countdown,
  Commit and Roll back. On the right: a ⋯ menu for the rarely needed, Ask
  and Seed together in the AI colour, and a split Run button whose menu
  runs all statements, runs on an environment set, or plans only. Plan,
  Explain and Format left the header — they act on one statement, so they
  live on the statement's own strip, where Explain now carries the AI mark
  and Run on set its own icon.
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

[Unreleased]: https://github.com/overcodelions/overdb/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/overcodelions/overdb/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/overcodelions/overdb/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/overcodelions/overdb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/overcodelions/overdb/releases/tag/v0.1.0
