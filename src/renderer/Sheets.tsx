import { useEffect, useState } from 'react';
import { ConnectionForm } from './ConnectionForm';
import { EnvSetForm } from './EnvSetForm';
import { AboutSheet, BasicsSheet, ShortcutsSheet } from './Help';
import { ImportSheet } from './ImportSheet';
import { SeedSheet } from './SeedSheet';
import { BaselineSheet } from './BaselineSheet';
import { TicketsSheet } from './TicketsSheet';
import { TablePicker } from './TablePicker';
import { useStore } from './store';
import { SettingsSheet } from './SettingsSheet';

/// Backdrop + escape-to-close wrapper shared by every sheet, so no
/// individual sheet has to remember the dismissal rules.
export function SheetHost(): JSX.Element | null {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, setSheet]);

  if (!sheet) return null;

  // The help sheets explain in paragraphs and two columns; at a form's
  // width they would be a long thin scroll. One frame for all three, so
  // following a footer link does not resize the sheet under the pointer.
  const help = sheet.kind === 'about' || sheet.kind === 'basics' || sheet.kind === 'shortcuts';
  // Settings is a rail of sections beside one pane. A fixed frame, so
  // moving between sections does not resize the sheet under the pointer.
  const settings = sheet.kind === 'settings';

  return (
    <div
      // Sheets hang from near the top so a form that grows as you fill it
      // grows downward instead of jumping. The seed sheet has a fixed
      // height — it cannot jump — so it sits in the middle, where a tall
      // dialog belongs.
      className={`fixed inset-0 z-40 flex justify-center bg-black/40 ${
        settings || sheet.kind === 'seed' || sheet.kind === 'baseline' || sheet.kind === 'tickets' ? 'items-center py-6' : `items-start ${help ? 'pt-14' : 'pt-24'}`
      }`}
      onClick={() => setSheet(null)}
    >
      <div
        className={`${
          settings
            ? 'w-[min(880px,calc(100vw-48px))] h-[min(620px,calc(100vh-96px))] flex flex-col overflow-hidden'
            : help
            ? 'w-[760px] max-w-[calc(100vw-48px)] max-h-[80vh] overflow-hidden'
            : sheet.kind === 'seed' || sheet.kind === 'baseline' || sheet.kind === 'tickets'
              // A five-step flow with a plan and a script side by side: it
              // needs a fixed frame, or every step resizes under the pointer.
              // Grows with the window up to a comfortable reading size: a
              // plan beside its rules, or a script beside its checks, needs
              // the room, and at 880×720 both were scrolling in slivers.
              ? 'w-[min(1200px,calc(100vw-96px))] h-[min(900px,calc(100vh-96px))] min-w-[min(880px,calc(100vw-48px))] min-h-[min(640px,calc(100vh-48px))] flex flex-col overflow-hidden'
              : `${sheet.kind === 'importConnections' ? 'w-[680px]' : 'w-[520px]'} max-w-[calc(100vw-48px)] max-h-[70vh] flex flex-col overflow-hidden`
        } rounded-lg border border-card bg-surface-elevated shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet.kind === 'about' && <AboutSheet />}
        {sheet.kind === 'basics' && <BasicsSheet />}
        {sheet.kind === 'shortcuts' && <ShortcutsSheet />}
        {sheet.kind === 'settings' && <SettingsSheet section={sheet.section} />}
        {sheet.kind === 'newConnection' && (
          <ConnectionForm found={sheet.found} onDone={() => setSheet(null)} />
        )}
        {sheet.kind === 'editConnection' && <EditConnectionSheet id={sheet.id} failure={sheet.failure} />}
        {sheet.kind === 'importConnections' && <ImportSheet />}
        {sheet.kind === 'newEnvSet' && (
          <EnvSetForm suggested={sheet.suggested} onDone={() => setSheet(null)} />
        )}
        {sheet.kind === 'editEnvSet' && (
          <EnvSetForm id={sheet.id} onDone={() => setSheet(null)} />
        )}
        {sheet.kind === 'seed' && <SeedSheet connectionId={sheet.connectionId} />}
        {sheet.kind === 'baseline' && <BaselineSheet connectionId={sheet.connectionId} />}
        {sheet.kind === 'tickets' && <TicketsSheet />}
        {sheet.kind === 'pickTables' && (
          <TablePicker connectionId={sheet.connectionId} onClose={() => setSheet(null)} />
        )}
      </div>
    </div>
  );
}

function PlaceholderSheet({ title }: { title: string }): JSX.Element {
  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">{title}</h2>
      <p className="text-xs text-ink-muted">Not built yet.</p>
    </div>
  );
}

function EditConnectionSheet({ id, failure }: { id: string; failure?: string }): JSX.Element {
  const connection = useStore((s) => s.connections.find((c) => c.id === id));
  const setSheet = useStore((s) => s.setSheet);
  if (!connection) {
    return <div className="p-5 text-xs text-ink-muted">That connection no longer exists.</div>;
  }
  // Keyed on the id so switching which connection you're editing resets the
  // form's state instead of carrying the previous one's values over.
  return <ConnectionForm key={id} existing={connection} failure={failure} onDone={() => setSheet(null)} />;
}
