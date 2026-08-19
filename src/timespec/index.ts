/**
 * @fileoverview
 * ★ TIMESPEC — an internally-owned library, deliberately held at arm's length.
 *
 * Duration strings (`'1h 30m'` → milliseconds) and wall-clock rules ("9:00 on
 * weekdays, Chicago time" → the next matching instant). That is the whole
 * surface, and none of it knows this repo exists: no `protocol/`, no workflows,
 * no history, no engine vocabulary. Treat it exactly like a third-party
 * dependency that happens to live in the tree — the test for any change here is
 * "would this API make sense published on its own?"
 *
 * ## The contract, and where it is enforced
 *
 * - **It imports nothing.** Not other layers, not Node builtins — the layering
 *   map (`tools/boundaries.ts`) pins `timespec: []`, same as `protocol/`.
 * - **The engine touches it only at named call sites.** The seam — every file
 *   allowed to import this library — is asserted by `spec/timespec/seam.spec.ts`,
 *   which is also the removal instruction: delete this directory, revert those
 *   files to their numbers-only forms, and the engine is whole again. If a new
 *   import site appears without being added there deliberately, the suite fails.
 * - **`duration.ts` is replay-safe and machine-checked for it** — it is called
 *   from the deterministic core (`sleep('30 minutes')` parses during replay), so
 *   it is held to the same purity rules as `core/`. `wall_clock.ts` reads the
 *   platform's timezone data and is exempted by name; the host must call it only
 *   where non-determinism is acceptable (this repo: inside an activity, whose
 *   answer is recorded).
 *
 * Why a library and not a layer of the engine: the alternative homes were tried
 * first — the parser in `protocol/` and the calendar arithmetic in `schedule/` —
 * and worked, but coupled removable convenience to permanent vocabulary. This
 * shape keeps the trade honest: if the features don't earn their keep, deleting
 * them is an afternoon, not an excavation.
 */

export {durationToMs, type Duration} from './duration';

export {
  nextOccurrenceAfter,
  previousOccurrenceAtOrBefore,
  wallClockRuleProblems,
  type WallClockRule,
} from './wall_clock';
