// What actually travels between two steps.
//
// A plan reports, per step, how many rows it reads on ONE run and how many
// runs it makes. It never reports how many rows a step HANDS ON, and every
// picture of a plan needs that number: without it there is no drop to draw
// and no ratio to state.
//
// The obvious guess — "the next step's row count" — is wrong wherever a
// nested loop is involved, and a nested loop is the thing worth drawing. In
// the plan that prompted this, `partner` reads 28,616 rows and the step
// after it reports `1 row, 143 loops`. Read naively that says partner passed
// on a single row, and the picture printed "−28,615 → 1" beside a step
// tagged ×143: two numbers that cannot both be true.
//
// The loop count IS the answer. A step that runs 143 times runs once per row
// from the step driving it, so the step before it produced 143 rows. Reading
// the output off the consumer's loop count rather than its row count is the
// whole of this module, and it makes the drop, the multiplier and the
// survivor count agree for the first time.

/// The subset of a step this needs, structural so callers keep their own
/// richer types.
export interface FlowStep {
  /// Rows read on ONE run.
  per: number;
  /// How many times the step runs.
  runs: number;
  /// What share of the rows this step reads survive its own condition,
  /// 0 to 100 — MySQL's `filtered`.
  ///
  /// This is the WHERE clause, and it is the only account of the filtering
  /// a plan gives you without ANALYZE. It sits in the plan table six
  /// columns away from the row count it applies to, which is why nobody
  /// multiplies the two, and it is what makes a 28,616-row scan that
  /// answers with eighty rows LOOK like a 28,616-row scan that answers with
  /// 28,616.
  filtered?: number;
  /// Whether `per` is a per-lookup figure — an `eq_ref` or `const` join,
  /// which reads its row once for every row handed to it.
  ///
  /// Without this the fallback below reads `rows: 1` on a driven step as
  /// "one row in total" and concludes the step before it discarded
  /// everything it read. On a plan with no ANALYZE, where no loop counts
  /// are reported at all, that invented a 28,615-row drop on the first
  /// step of every join and drew it as the finding of the whole view.
  driven?: boolean;
}

export interface Flow {
  /// Rows this step reads in total: `per` × `runs`.
  read: number;
  /// Rows it hands on to whatever comes next.
  out: number;
  /// Rows it read that go no further. Never negative.
  dropped: number;
  /// Whether `out` is the server's ESTIMATE of what survives rather than a
  /// count of what did. Said out loud wherever the number is: an estimate
  /// drawn as a measurement is the plan's own commonest lie.
  estimated: boolean;
  /// How much the stream INTO this step widens because of its own loop: the
  /// rows arriving are multiplied by this to get the rows read.
  ///
  /// ONLY A LOOPED STEP WIDENS. A step that runs once reads what it reads
  /// because it is a scan or a lookup, not because anything multiplied it —
  /// there is no arriving stream to multiply. Reporting its row count here
  /// made the first step of every plan claim it multiplied its own input by
  /// itself, which drew as `28,616 ×28,616 each` on the wire out of
  /// `select`.
  ///
  /// It is also 1 for the common `eq_ref` loop, where each run reads exactly
  /// one row. That case is not free, but its cost is time rather than rows,
  /// so the picture says it in words instead of drawing a widening that
  /// would be a lie.
  widen: number;
}

/// The flow along one chain of steps, in the order the server runs them.
///
/// `returned` is what the statement actually gave back, when it has been
/// run. Only the OUTERMOST chain gets it: a subquery hands its rows to the
/// step it feeds, and how many survive that is not the subquery's to claim.
export function chainFlow(steps: FlowStep[], returned: number | null): Flow[] {
  return steps.map((step, i) => {
    const read = step.per * Math.max(1, step.runs);
    const next = steps[i + 1];
    // What this step's own condition lets through, when the server said.
    // Rounded up, because a condition that keeps 0.4 of a row keeps one:
    // rounding to zero draws a stream that stops dead and a query that
    // returns nothing.
    const survives =
      step.filtered === undefined ? null : Math.max(1, Math.ceil(read * (step.filtered / 100)));

    // In precedence order, most trustworthy first. Each rung is a different
    // KIND of knowledge, and the one that answers decides whether the drop
    // is drawn as measured or as an estimate.
    let out: number;
    let estimated = false;
    if (next === undefined) {
      // The last step of the outermost chain hands back the result.
      out = returned ?? survives ?? read;
      estimated = returned === null && survives !== null;
    } else if (next.runs > 1) {
      // The consumer's loop count is the producer's row count — measured,
      // and it beats an estimate of the same thing.
      out = next.runs;
    } else if (survives !== null) {
      // The server's own account of this step's condition. Not a
      // measurement, and labelled as such wherever it is drawn.
      out = survives;
      estimated = true;
    } else if (next.driven) {
      // No loop count, no filter, and a per-lookup row count downstream:
      // the plan has told us nothing about how many rows leave here.
      out = read;
    } else {
      // An ordinary step's row count IS a total, so one pass over what it
      // was given is exactly what it reports.
      out = next.per * Math.max(1, next.runs);
    }

    const kept = Math.min(out, read);
    return {
      read,
      out: kept,
      dropped: Math.max(0, read - kept),
      estimated,
      widen: step.runs > 1 ? Math.max(1, step.per) : 1,
    };
  });
}
