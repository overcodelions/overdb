// `OVERDB_PROFILE=fresh npm run dev` runs the app against a userData folder
// of its own, so a first run can be seen — and tested — without touching the
// connections, history and keychain entries in the real one.
//
// Dev builds only: a packaged app that quietly moved its userData would look
// exactly like every saved connection had vanished. Imported first in
// index.ts, because anything that reads the userData path before this runs
// would pin the real one.

import { app } from 'electron';
import path from 'node:path';

const profile = process.env.OVERDB_PROFILE?.trim();
if (profile && !app.isPackaged) {
  const safe = profile.replace(/[^a-zA-Z0-9_-]+/g, '-');
  app.setPath('userData', path.join(app.getPath('appData'), `overdb-${safe}`));
}
