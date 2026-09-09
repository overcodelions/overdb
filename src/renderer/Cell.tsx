import type { Cell as CellValue, ColumnMeta } from '@shared/types';

/// Rendering rules that exist because a database client that blurs them is
/// lying to you:
///   - NULL and '' are different things and must LOOK different.
///   - A blank cell means "we rendered nothing", so an empty string gets a
///     visible mark rather than whitespace.
///   - Timestamps show the server's exact string. Silently converting to
///     local time is the classic client bug: it discards the offset the
///     server sent and you never find out.
///   - Numerics show the exact string, never a float round-trip.
export function CellView({ value, column }: { value: CellValue; column: ColumnMeta }): JSX.Element {
  if (value === null) {
    return <span className="text-ink-faint italic opacity-70">NULL</span>;
  }

  if (typeof value === 'object' && '__bin' in value) {
    return (
      <span className="text-ink-muted font-mono" title={`${value.byteLength} bytes`}>
        &lt;{formatBytes(value.byteLength)} binary&gt;
      </span>
    );
  }

  if (typeof value === 'boolean') {
    return <span className="font-mono">{value ? 'true' : 'false'}</span>;
  }

  if (typeof value === 'string') {
    if (value === '') {
      return <span className="text-ink-faint font-mono opacity-70">&#39;&#39;</span>;
    }
    if (value.trim() === '') {
      // Whitespace-only is otherwise indistinguishable from empty.
      return (
        <span className="text-ink-faint font-mono" title={`${value.length} whitespace characters`}>
          {'·'.repeat(Math.min(value.length, 12))}
        </span>
      );
    }
    if (column.kind === 'json') {
      return <span className="font-mono text-ink truncate">{value}</span>;
    }
  }

  const numeric =
    column.kind === 'int' || column.kind === 'bigint' ||
    column.kind === 'float' || column.kind === 'decimal';

  return (
    <span className={`font-mono truncate ${numeric ? 'tabular-nums' : ''}`}>{String(value)}</span>
  );
}

export function isNumericKind(kind: ColumnMeta['kind']): boolean {
  return kind === 'int' || kind === 'bigint' || kind === 'float' || kind === 'decimal';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
