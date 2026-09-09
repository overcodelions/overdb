// pg-cursor ships no type declarations. This covers the surface overdb
// uses: construct with (text, values, config) and pull batches with
// read(n, cb). Chosen over pg-query-stream deliberately — we want explicit
// pull-based chunking, not a Node stream we immediately have to pause.
declare module 'pg-cursor' {
  import type { Submittable } from 'pg';
  class Cursor<R = unknown[]> implements Submittable {
    constructor(text: string, values?: unknown[], config?: { rowMode?: 'array' });
    read(rowCount: number, callback: (err: Error | undefined, rows: R[]) => void): void;
    close(callback?: (err?: Error) => void): void;
    submit(connection: unknown): void;
  }
  export = Cursor;
}
