import type { PlanRow } from '@shared/plan';

/// The plan, as a table you can scan. Five columns answer most "why is this
/// slow" questions without anyone interpreting anything: what is being read,
/// how, using which index, how many rows the optimizer expected, and how
/// much of that survives the condition.
export function PlanView({ rows, raw }: { rows: PlanRow[]; raw: string }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-ink-faint">
        No plan returned.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-surface-muted">
          <tr className="text-left text-ink-faint">
            <Th>Step</Th>
            <Th>Access</Th>
            <Th>Key</Th>
            <Th className="text-right">Est. rows</Th>
            <Th className="text-right">Actual</Th>
            <Th className="text-right">Filtered</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={`border-b grid-rule ${row.warn ? 'bg-amber-500/10' : ''}`}>
              <td className="px-2.5 py-1 font-mono text-ink" style={{ paddingLeft: 10 + row.depth * 16 }}>
                {row.depth > 0 && <span className="text-ink-faint mr-1">└</span>}
                {row.title}
                {row.warn && (
                  <div className="mt-0.5 text-[10px] text-amber-400/90 font-sans">{row.warn}</div>
                )}
                {row.extra && (
                  <div className="mt-0.5 text-[10px] text-ink-faint font-mono truncate" title={row.extra}>
                    {row.extra}
                  </div>
                )}
              </td>
              <td className="px-2.5 py-1">
                {row.access && (
                  <span
                    className={`font-mono ${
                      row.warn && !row.key ? 'text-amber-400/90' : 'text-ink-muted'
                    }`}
                  >
                    {row.access}
                  </span>
                )}
              </td>
              <td className="px-2.5 py-1 font-mono text-ink-muted">
                {row.key ?? <span className="text-ink-faint">—</span>}
              </td>
              <td className="px-2.5 py-1 text-right font-mono tabular-nums text-ink-muted">
                {row.rows?.toLocaleString() ?? '—'}
              </td>
              <td className="px-2.5 py-1 text-right font-mono tabular-nums text-ink-muted">
                {row.actualRows?.toLocaleString() ?? '—'}
              </td>
              <td className="px-2.5 py-1 text-right font-mono tabular-nums text-ink-muted">
                {row.filtered !== undefined ? `${row.filtered}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="p-3">
        <summary className="text-[11px] text-ink-faint cursor-pointer">Raw plan</summary>
        <pre className="mt-2 text-[10px] font-mono whitespace-pre-wrap text-ink-muted">{raw}</pre>
      </details>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <th className={`px-2.5 py-1.5 font-medium border-b border-card ${className}`}>{children}</th>
  );
}
