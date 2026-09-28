import type { EnvKind } from '@shared/types';
import type { Variant } from '@shared/engines';

/// Written out as whole class strings, never interpolated. Tailwind scans
/// source text for class names, so `text-${colour}-300/70` emits no CSS at
/// all — the badge would render in the inherited colour and look broken.
///
/// The muting that keeps the badge below the connection's own name lives
/// in the token, not in an opacity modifier here: how far a hue has to be
/// pulled back to sit under the name is not the same on both grounds.
export const TAG_TEXT: Record<Variant, string> = {
  postgres: 'text-tag-sky',
  redshift: 'text-tag-rose',
  'aurora-postgres': 'text-tag-cyan',
  cockroach: 'text-tag-violet',
  timescale: 'text-tag-indigo',
  mysql: 'text-tag-amber',
  mariadb: 'text-tag-orange',
  'aurora-mysql': 'text-tag-cyan',
  sqlite: 'text-tag-emerald',
  dynamodb: 'text-tag-blue',
};

/// The same colours as a dot, for widths too narrow to spell the name.
export const TAG_DOT: Record<Variant, string> = {
  postgres: 'bg-tag-sky',
  redshift: 'bg-tag-rose',
  'aurora-postgres': 'bg-tag-cyan',
  cockroach: 'bg-tag-violet',
  timescale: 'bg-tag-indigo',
  mysql: 'bg-tag-amber',
  mariadb: 'bg-tag-orange',
  'aurora-mysql': 'bg-tag-cyan',
  sqlite: 'bg-tag-emerald',
  dynamodb: 'bg-tag-blue',
};

/// An environment as a dot. Prod is the one that must never be mistaken
/// for anything else, so it takes the caution hue the rest of the app
/// already gives it; local is green because nothing there can hurt anyone.
export const ENV_DOT: Record<EnvKind, string> = {
  local: 'bg-good',
  dev: 'bg-tag-blue',
  sandbox: 'bg-tag-violet',
  staging: 'bg-tag-cyan',
  prod: 'bg-warn',
  other: 'bg-ink-faint',
};
