/**
 * @fileoverview
 * Running one control action over many executions, and reporting what happened
 * to each.
 *
 * There is no batch method on the RPC and this deliberately does not add one.
 * A page is capped at fifty rows, so the largest batch anyone can express here
 * is fifty sequential calls — cheaper to write, cheaper to reason about, and it
 * keeps the server's surface the same size. A real batch endpoint is the answer
 * to "terminate ten thousand", which is not a thing this UI can ask for.
 *
 * DOM-free, so the suite covers it (`spec/dashboard/batch.spec.ts`). Every case
 * worth pinning down is a partial-failure case, and those are the ones that are
 * awkward to produce against a live server.
 *
 * ## It does not stop at the first failure
 *
 * Some of a selection will often be un-actionable by the time the batch runs —
 * an execution that settled between the last poll and the click is the ordinary
 * case, not an exotic one. Aborting there would leave the operator with a
 * half-applied action and no record of where it stopped. Every id is attempted,
 * and the outcome of each is returned.
 *
 * ## Sequential, not concurrent
 *
 * Fifty parallel writes against a single-node engine is a burst with nothing to
 * gain: the calls are short, the operator is watching a progress line rather
 * than racing a deadline, and serial order makes "it stopped after seventeen"
 * mean something if the tab is closed midway.
 */

/** What happened to one execution in a batch. */
export interface BatchOutcome {
  workflowId: string;
  ok: boolean;
  /** Why it failed. Absent when `ok`. */
  error?: string;
}

/** A batch in progress, or the finished shape of one. */
export interface BatchProgress {
  done: number;
  total: number;
  outcomes: BatchOutcome[];
}

/**
 * Apply `action` to every id in order.
 *
 * `onProgress` is called after each one so a caller can render a running count;
 * it is given the same array that is ultimately returned, so a caller holding it
 * sees the outcomes accumulate.
 */
export async function runBatch(
  workflowIds: readonly string[],
  action: (workflowId: string) => Promise<unknown>,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchOutcome[]> {
  const outcomes: BatchOutcome[] = [];
  for (const workflowId of workflowIds) {
    try {
      await action(workflowId);
      outcomes.push({workflowId, ok: true});
    } catch (e) {
      outcomes.push({
        workflowId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    onProgress?.({done: outcomes.length, total: workflowIds.length, outcomes});
  }
  return outcomes;
}

/** The ones that did not work. Empty means the whole batch landed. */
export function failuresOf(outcomes: readonly BatchOutcome[]): BatchOutcome[] {
  return outcomes.filter((o) => !o.ok);
}
