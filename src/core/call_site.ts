/**
 * @fileoverview
 * Where a primitive was called from, captured cheaply and formatted lazily.
 *
 * Two consumers, one cost argument. `condition.ts` reports the sites of
 * still-parked conditions; `apply_event.ts` stitches a command's await site
 * onto a failure crossing back into workflow code, so an activity's stack from
 * another process connects to the workflow line that awaited it. Both capture
 * on every call and format almost never, and that asymmetry is the whole
 * design: V8 builds the formatted stack lazily, on first access to `.stack`,
 * so `captureSite` walks a bounded number of frames and the expensive
 * serialization happens only for a condition still parked at task end or a
 * command that actually failed.
 *
 * Sites are a pure diagnostic side-channel. They are never read by replay,
 * never reach a command, and never influence what the workflow does — which is
 * what keeps per-replay capture (and its host-version-dependent frame text)
 * outside the determinism boundary's concern.
 */

/**
 * `any` because `strictFunctionTypes` makes parameters contravariant: a real
 * `(name: string) => …` is not assignable to `(...args: unknown[]) => …`, so a
 * cutoff typed that way would accept none of the primitives that pass
 * themselves here. Same justification as the registry function types.
 */
type AnyFn = (...args: any[]) => unknown;

/**
 * How many frames a site keeps.
 *
 * The useful ones are the workflow's own, and they are at the top. Bounding the
 * capture is what keeps it cheap — the walk is proportional to this, and the
 * default of ten buys frames nobody reads.
 */
const SITE_FRAMES = 6;

/**
 * Where the calling primitive was invoked, captured as cheaply as it can be.
 *
 * `captureStackTrace` with `cutoff` (the caller's own exported function) drops
 * that function and everything beneath it, so the top frame is as close to the
 * workflow's own call as the call path allows.
 */
export function captureSite(cutoff: AnyFn): Error | undefined {
  const capture = Error.captureStackTrace;
  // V8 only. Everywhere else a site is simply absent, which every reader of
  // one already tolerates — history written before sites existed has none.
  if (typeof capture !== 'function') return undefined;
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = SITE_FRAMES;
  const site = new Error();
  capture(site, cutoff);
  // Restored immediately, with no await in between, so nothing can observe the
  // narrowed limit.
  Error.stackTraceLimit = previousLimit;
  return site;
}

/**
 * A site's frames, formatted and trimmed to the workflow's own: innermost
 * first, the leading `Error` line dropped, engine frames cut from both ends.
 * Undefined when the site has no stack to read.
 */
export function siteFrames(site: Error | undefined): string[] | undefined {
  const frames = site?.stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return frames === undefined ? undefined : workflowFrames(frames);
}

/**
 * Drop the engine frames around the workflow's own.
 *
 * Two trims, one at each end. `replay` is what invokes the workflow function,
 * so everything from that frame down is this engine's call stack rather than
 * the reader's code. At the top, a command site's first frames are the
 * primitives themselves — `runActivity`, `sleep`, the activity proxy — all in
 * `core/workflow_api`, and a failure pointing at `sleep`'s implementation says
 * nothing the seam line doesn't already.
 *
 * Matching on file names is a heuristic, and it degrades the right way twice
 * over: a missed marker (a bundle that renames paths, say) leaves extra frames
 * rather than none, and the last frame standing is never dropped — a site with
 * nothing in it would be worse than a site with engine frames in it.
 */
function workflowFrames(frames: string[]): string[] {
  const engine = frames.findIndex(
    (frame) => frame.includes('core/replay') || frame.includes('core\\replay'),
  );
  const trimmed = engine > 0 ? frames.slice(0, engine) : frames;
  let start = 0;
  while (
    start < trimmed.length - 1 &&
    (trimmed[start]!.includes('core/workflow_api') ||
      trimmed[start]!.includes('core\\workflow_api'))
  )
    start++;
  return trimmed.slice(start);
}
