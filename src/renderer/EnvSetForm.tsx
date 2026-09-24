import { useMemo, useState } from 'react';
import type { Connection, EnvKind } from '@shared/types';
import { variantLabel } from '@shared/engines';
import { useStore } from './store';

/// An environment set is the same logical database in several places —
/// local, staging, prod. Picking members is therefore the whole form, and
/// the baseline is the one question that needs explaining: everything else
/// gets compared against it, so "prod drifted from staging" has a direction.
///
/// The shape it will take is drawn rather than described (`SetDiagram`): a
/// paragraph explaining fan-out is a paragraph, whereas one baseline with
/// lines running out to the members you just ticked is the thing itself.
/// The drawing is of the SET, never of results — the fan-out that fills it
/// in is not built yet, and a mocked "2 columns differ" here would be a lie
/// the form tells before you have run anything.

const ENV_ORDER: EnvKind[] = ['local', 'dev', 'sandbox', 'staging', 'prod', 'other'];

export function EnvSetForm({
  id,
  suggested,
  onDone,
}: {
  id?: string;
  /// Members the sidebar's hint thinks are one database. A starting point,
  /// not a decision: every box can still be changed before Create.
  suggested?: { name: string; memberIds: string[]; baselineId: string };
  onDone(): void;
}): JSX.Element {
  const connections = useStore((s) => s.connections);
  const envSets = useStore((s) => s.envSets);
  const saveEnvSet = useStore((s) => s.saveEnvSet);
  const existing = id ? envSets.find((e) => e.id === id) : undefined;

  const [name, setName] = useState(existing?.name ?? suggested?.name ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(
    existing?.memberIds ?? suggested?.memberIds ?? [],
  );
  const [baselineId, setBaselineId] = useState(
    existing?.baselineId ?? suggested?.baselineId ?? '',
  );
  const [saving, setSaving] = useState(false);

  const byEnv = useMemo(
    () =>
      ENV_ORDER.map((env) => ({ env, items: connections.filter((c) => c.env === env) })).filter(
        (b) => b.items.length > 0,
      ),
    [connections],
  );

  const members = memberIds
    .map((mid) => connections.find((c) => c.id === mid))
    .filter((c): c is Connection => Boolean(c));
  const baseline = members.find((c) => c.id === baselineId);
  const others = members.filter((c) => c.id !== baselineId);

  const toggle = (cid: string) =>
    setMemberIds((prev) => {
      const next = prev.includes(cid) ? prev.filter((x) => x !== cid) : [...prev, cid];
      // Dropping the baseline out of the set has to move the baseline, or
      // the set saves pointing at a connection it no longer contains.
      if (!next.includes(baselineId)) setBaselineId(next[0] ?? '');
      else if (!baselineId && next.length) setBaselineId(next[0]);
      return next;
    });

  // Two is the point. A set of one is a connection, and the whole reason
  // this screen exists is running somewhere and comparing it somewhere else.
  const problem =
    !name.trim() ? 'Name the set so you can find it later.'
    : memberIds.length < 2 ? 'Pick at least two connections — a set of one is just a connection.'
    : null;

  const submit = async () => {
    if (problem) return;
    setSaving(true);
    try {
      await saveEnvSet({ id, name, memberIds, baselineId });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col max-h-[70vh]"
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-3 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {existing ? `Edit ${existing.name}` : 'New environment set'}
          </h2>
          <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">
            The same logical database in several places, grouped under one name and pointed at a
            baseline — so a comparison between them has a direction.
          </p>
        </div>
        <SetDiagram baseline={baseline} others={others} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 flex flex-col gap-4">
        <label className="flex items-center gap-2.5">
          <span className="shrink-0 text-[11px] text-ink-muted">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme core"
            className="field flex-1 px-2.5 py-1.5 text-xs"
          />
        </label>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-ink-muted">Members</span>
            <span className="text-[10px] text-ink-faint tabular-nums">
              {memberIds.length} of {connections.length} selected
            </span>
          </div>

          {byEnv.map(({ env, items }) => (
            <div key={env} className="flex flex-col gap-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                {env}
              </div>
              {/* Two columns because the list is the tall part of this
                  sheet, and a connection row is mostly empty space. */}
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((c) => {
                  const on = memberIds.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      title={`${c.name} — ${variantLabel(c.variant, c.engine)}${
                        c.database ? ` · ${c.database}` : ''
                      }`}
                      className={`flex items-center gap-2 min-w-0 px-2 py-1.5 rounded border cursor-default ${
                        on
                          ? 'border-accent/45 bg-accent/10'
                          : 'border-card bg-wash hover:bg-card'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(c.id)}
                        className="accent-accent shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] text-ink truncate">{c.name}</span>
                        <span className="block text-[9px] text-ink-faint truncate">
                          {variantLabel(c.variant, c.engine)}
                        </span>
                      </span>
                      {c.env === 'prod' && (
                        <span className="shrink-0 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-warn/10 text-warn/90 border border-warn/25">
                          prod
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <label className="flex items-center gap-2.5">
          <span className="shrink-0 text-[11px] text-ink-muted">Compare against</span>
          <select
            value={baselineId}
            onChange={(e) => setBaselineId(e.target.value)}
            disabled={members.length === 0}
            className="field px-2 py-1 text-xs disabled:opacity-40"
          >
            {members.length === 0 && <option value="">Pick members first</option>}
            {members.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.env}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="shrink-0 border-t border-card px-5 py-3 flex items-center gap-3">
        <span className="text-[11px] text-ink-faint leading-snug min-w-0">{problem}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDone}
          className="shrink-0 text-xs px-3 py-1.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={Boolean(problem) || saving}
          className="shrink-0 text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Create set'}
        </button>
      </div>
    </form>
  );
}

/// One baseline on the left, a line out to each of the other members. Row
/// geometry is fixed rather than measured — the wires have to land on the
/// row centres, and a resize observer to draw three lines would be a lot of
/// machinery for a picture.
const ROW_H = 24;
const ROW_GAP = 6;
const PITCH = ROW_H + ROW_GAP;

function SetDiagram({
  baseline,
  others,
}: {
  baseline?: Connection;
  others: Connection[];
}): JSX.Element {
  const height = Math.max(ROW_H, others.length * PITCH - ROW_GAP);
  const mid = height / 2;

  return (
    <div className="rounded-md border border-card bg-surface px-3.5 py-3 flex items-center gap-3">
      {baseline ? (
        <div className="shrink-0 flex flex-col items-center gap-1 max-w-[45%]">
          <span className="text-[11px] text-ink px-2 py-1 rounded border border-accent/45 bg-accent/[0.16] truncate max-w-full">
            {baseline.name}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-accent">baseline</span>
        </div>
      ) : (
        <span className="text-[11px] text-ink-faint">
          Pick two or more connections below to shape the set.
        </span>
      )}

      {others.length > 0 && (
        <>
          <svg
            width="44"
            height={height}
            viewBox={`0 0 44 ${height}`}
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <path
              d={`M2 ${mid}H16`}
              stroke="var(--c-card-border)"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            {others.map((c, i) => (
              <path
                key={c.id}
                d={`M16 ${mid}C28 ${mid} 28 ${i * PITCH + ROW_H / 2} 40 ${i * PITCH + ROW_H / 2}`}
                stroke="var(--c-card-border)"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            ))}
            <circle cx="16" cy={mid} r="2.4" className="fill-accent" />
          </svg>

          <div className="flex flex-col gap-1.5 min-w-0 flex-1">
            {others.map((c) => (
              <div
                key={c.id}
                style={{ height: ROW_H }}
                className="flex items-center gap-2 min-w-0"
              >
                <span className="text-[11px] text-ink px-2 py-1 rounded border border-card bg-wash truncate">
                  {c.name}
                </span>
                <span className="text-[10px] text-ink-faint shrink-0">{c.env}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
