# Screenshots

The top-level `README.md` shows these images. They're generated, not hand-captured, so they can be refreshed whenever the UI changes.

| File | Shows |
|---|---|
| `hero.png` | Hero: the sidebar grouped by environment with engine tiles, and a query on `acme-shop · prod` with its results |
| `env-set.png` | The `acme-shop` environment set: one query on local, staging and prod, compared with the prod baseline |
| `schema-drift.png` | Schema drift for the same set: a missing index on staging, a table and a column only local has |
| `tables.png` | The table list beside the editor, `orders` expanded, its rows in the grid (sidebar folded) |
| `agents.png` | The Agents sheet: register command, who is connected, what agents can read, the activity log |
| `agents-chip.png` | The Agents chip's menu on `acme-shop · prod` |
| `agents-told.png` | Agents sheet → What agents are told: notes, tenancy and caveats beside the exact briefing |

All are dark theme.

## Regenerating

```bash
npm run build
npm i --no-save playwright-core
pip3 install pillow   # once, for framing
node scripts/readme-screenshots/capture.mjs
```

[`scripts/readme-screenshots/`](../../scripts/readme-screenshots/) does the whole job:

- **`seed.mjs`** builds a throwaway HOME in your temp dir holding the fictional `acme-shop` database as three SQLite files — local, staging and prod, drifted apart on purpose — and writes a `readme-shots` profile: those three as an environment set, ten other acme connections on `.example` hosts (so the sidebar shows every engine tile), editor buffers, what agents are told, and an agent's presence file and call log.
- **`capture.mjs`** runs the built app against that HOME and profile, so none of your own connections, history or paths can appear in an image. Only the SQLite files are ever opened; the network connections are never clicked, and `.example` never resolves. It clicks through each scene at 1600×1000 and 2× scale, rewrites the temp HOME to `~` and the dev build's register command to the packaged app's, refuses to capture if your home folder, username or checkout path is still on screen, then deletes the profile.
- **`frame.py`** adds macOS window chrome (traffic lights, rounded corners, soft shadow) on a transparent background, so the images work in GitHub's light and dark themes.

The "connected" agent is the capture process itself: its pid is written as the presence file, so the app sees a live client for as long as the capture runs.

## Adding a shot

Add a scene to `capture.mjs`, add any data it needs to `seed.mjs`, then add a row above and an image to the README. Keep names `kebab-case.png`, and keep everything fictional: acme names, `example.com` emails and `.example` hosts only, no real people, companies, paths or account IDs.
