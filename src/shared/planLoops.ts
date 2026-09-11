// Finding the loop a plan does not admit to.
//
// A nested-loop join is the commonest reason a query that looks cheap is not,
// and the plan says it without saying it: `eq_ref` and `const` mean "one row
// per lookup", and a lookup only exists because something is calling it. So a
// run of them following a step that produces many rows IS a loop, whether or
// not the server told us how many times it turns.
//
// The count is reported only when it is known — from the step's own `loops`,
// or from the rows the driver produces. An arc with no number still says the
// true thing: this happens again for every row.

import type { PlanRow } from './plan';

/// The subset of a drawn step this needs. Structural rather than imported,
/// so the renderer keeps its own richer type.
export interface LoopStep {
  row: PlanRow;
  /// Rows read on ONE run.
  per: number;
  /// Times this step runs, when the plan said so.
  runs: number;
  /// Nesting tier — a loop never spans two of them.
  tier: number;
}

export interface Run {
  /// Index of the first and last step the loop covers.
  first: number;
  last: number;
  /// The step whose rows drive it.
  driver: string;
  /// How many times, when that is known.
  times: number | null;
}

const DRIVEN = new Set(['eq_ref', 'const', 'unique_subquery', 'index_subquery', 'ref']);

/// Whether a step's row count is PER LOOKUP rather than a total.
///
/// The distinction matters wherever one step's numbers are used to say
/// something about another's: `eq_ref` reporting `rows: 1` means "one row
/// each time I am called", and reading it as "one row in total" turns the
/// step feeding it into a filter that threw away everything it read.
export function isDriven(access: string | undefined): boolean {
  return DRIVEN.has((access ?? '').toLowerCase());
}

export function drivenRuns(steps: LoopStep[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const prev = steps[i - 1];
    const driven =
      prev &&
      step.tier === prev.tier &&
      DRIVEN.has((step.row.access ?? '').toLowerCase()) &&
      prev.per > 1;
    if (!driven) {
      i += 1;
      continue;
    }
    const first = i;
    while (
      i + 1 < steps.length &&
      steps[i + 1].tier === step.tier &&
      DRIVEN.has((steps[i + 1].row.access ?? '').toLowerCase())
    ) {
      i += 1;
    }
    const surviving = Math.round(prev.per * ((prev.row.filtered ?? 100) / 100));
    runs.push({
      first,
      last: i,
      driver: prev.row.title,
      times: steps[first].runs > 1 ? steps[first].runs : surviving > 1 ? surviving : null,
    });
    i += 1;
  }
  return runs;
}

