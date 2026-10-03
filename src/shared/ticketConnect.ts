// How to reach a ticket copy from outside overdb: the address, and the
// same address spelled the ways the code you point at it expects — a
// DATABASE_URL, a JDBC URL, Spring and Laravel settings, the mysql client.
// Built from the copy's real port and the source connection's user and
// database. The password is never in here: it is the same as your local
// server's, and overdb does not hand credentials to the window.

import type { Engine } from './engines';

export interface TicketAddress {
  engine: Engine;
  host: string;
  port: number;
  user: string;
  /// The schema services use by default, when the source connection has one.
  database: string | null;
}

export interface Snippet {
  id: string;
  label: string;
  text: string;
}

/// Characters a URL's user or path must escape.
const enc = (s: string) => encodeURIComponent(s);

export function connectSnippets(a: TicketAddress): Snippet[] {
  const db = a.database ?? '';
  const slashDb = db ? `/${enc(db)}` : '';
  if (a.engine === 'postgres') {
    return [
      { id: 'env', label: '.env', text: [`DATABASE_URL=postgres://${enc(a.user)}:<your password>@${a.host}:${a.port}${slashDb}`, `PGHOST=${a.host}`, `PGPORT=${a.port}`, `PGUSER=${a.user}`, ...(db ? [`PGDATABASE=${db}`] : [])].join('\n') },
      { id: 'jdbc', label: 'JDBC / Spring', text: [`spring.datasource.url=jdbc:postgresql://${a.host}:${a.port}${slashDb}`, `spring.datasource.username=${a.user}`].join('\n') },
      { id: 'cli', label: 'psql', text: `psql -h ${a.host} -p ${a.port} -U ${a.user}${db ? ` ${db}` : ''}` },
    ];
  }
  return [
    {
      id: 'env',
      label: '.env',
      text: [`DATABASE_URL=mysql://${enc(a.user)}:<your password>@${a.host}:${a.port}${slashDb}`, `DB_HOST=${a.host}`, `DB_PORT=${a.port}`, `DB_USERNAME=${a.user}`, ...(db ? [`DB_DATABASE=${db}`] : [])].join('\n'),
    },
    {
      id: 'jdbc',
      label: 'JDBC / Spring',
      text: [`spring.datasource.url=jdbc:mysql://${a.host}:${a.port}${slashDb}`, `spring.datasource.username=${a.user}`].join('\n'),
    },
    { id: 'cli', label: 'mysql', text: `mysql -h ${a.host} -P ${a.port} -u ${a.user} -p${db ? ` ${db}` : ''}` },
  ];
}

/// The one-line address, for saying where it is.
export function addressLine(a: TicketAddress): string {
  return `${a.host}:${a.port}${a.database ? ` · ${a.database}` : ''} · user ${a.user}`;
}
