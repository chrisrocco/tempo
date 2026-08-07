/**
 * @fileoverview
 * The dashboard's one polling loop, as a Lit reactive controller.
 *
 * Every view here answers the same question — "what does the server say now?" —
 * and each one that grew its own `setInterval` would get the same four details
 * wrong in a slightly different way. Owning them once is the point:
 *
 * 1. **A chained timeout, not an interval.** `setInterval` fires on a schedule
 *    regardless of whether the previous request finished, so a server that
 *    answers slower than the interval gets a queue of overlapping requests that
 *    never drains. The next tick is scheduled when the last one settles.
 * 2. **Backoff on failure.** A dashboard left open against a server that went
 *    away should not poll it twice a second forever. Consecutive failures back
 *    off exponentially to `MAX_BACKOFF_MS`; the first success resets it.
 * 3. **Paused while hidden.** A background tab needs no data. Polling stops on
 *    `visibilitychange` and refreshes immediately on return, so coming back to
 *    the tab shows current state rather than whatever was on screen minutes ago.
 * 4. **Aborted on disconnect.** The in-flight request is cancelled when the host
 *    element goes away, so navigating off a detail view does not leave a fetch
 *    running to update an element no longer in the document.
 *
 * The controller holds the *outcome* — `value`, `error`, `pending` — and asks
 * the host to re-render when any of them changes. Views read those three fields
 * and stay dumb, which is what keeps the polling policy in one file.
 */

import type {ReactiveController, ReactiveControllerHost} from 'lit';

/** How often a healthy poll repeats. */
export const POLL_INTERVAL_MS = 2000;

/** The ceiling on the backoff delay after consecutive failures. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * One request, given a signal that is aborted if the host disconnects or the
 * task is replaced. Implementations should pass it to `fetch` rather than
 * ignoring it — that is what makes cancellation real rather than cosmetic.
 */
export type PollTask<T> = (signal: AbortSignal) => Promise<T>;

/**
 * A repeating read of one thing from the server.
 *
 * Construct it in a host's field initializer; it registers itself and starts
 * when the host connects.
 */
export class Poller<T> implements ReactiveController {
  /** The most recent successful result, or undefined before the first one. */
  value: T | undefined = undefined;

  /**
   * Why the most recent attempt failed, cleared by the next success.
   *
   * `value` is deliberately *not* cleared alongside it: a dashboard whose server
   * blinked should keep showing the last known state with an error beside it,
   * rather than flashing empty and back on every hiccup.
   */
  error: string | undefined = undefined;

  /** True while a request is in flight, for a first-load spinner. */
  pending = false;

  private task: PollTask<T>;
  private timer: ReturnType<typeof window.setTimeout> | undefined;
  private inFlight: AbortController | undefined;
  private failures = 0;
  private connected = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    task: PollTask<T>,
    private readonly intervalMs = POLL_INTERVAL_MS,
  ) {
    this.task = task;
    host.addController(this);
  }

  hostConnected(): void {
    this.connected = true;
    window.document.addEventListener(
      'visibilitychange',
      this.onVisibilityChange,
    );
    // Fire-and-forget by design: `run` reports failure through `error` rather
    // than rejecting, and there is no caller here to await it.
    void this.run();
  }

  hostDisconnected(): void {
    this.connected = false;
    window.document.removeEventListener(
      'visibilitychange',
      this.onVisibilityChange,
    );
    this.cancel();
  }

  /**
   * Point the poller at a different subject and read it immediately.
   *
   * This is how the detail view follows a route change: the element survives,
   * the workflow id it is watching does not. The current value is dropped
   * because it describes the *old* subject, and leaving it on screen would
   * label one execution's panels with another's id until the first response
   * lands. The in-flight request is aborted, and its result would be ignored
   * even if it landed first.
   */
  replaceTask(task: PollTask<T>): void {
    this.value = undefined;
    this.error = undefined;
    this.replaceTaskKeepingValue(task);
  }

  /**
   * Point the poller at a different *view of the same subject*, leaving the
   * current value on screen until the new one arrives.
   *
   * The distinction from `replaceTask` is whether the value still describes
   * what the user is looking at. Turning a history page does not make the
   * execution's status or failure stale, so blanking the whole view for one
   * round trip would be a flicker with no information in it.
   */
  replaceTaskKeepingValue(task: PollTask<T>): void {
    this.task = task;
    this.cancel();
    if (this.connected) void this.run();
  }

  /** Read now, and restart the interval from this moment. */
  refresh(): void {
    this.cancel();
    if (this.connected) void this.run();
  }

  /** Stop the timer and abort whatever is in flight. */
  private cancel(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    this.inFlight = controller;
    this.pending = true;
    this.host.requestUpdate();
    try {
      const value = await this.task(controller.signal);
      // A result that arrives after this request was superseded belongs to a
      // task nobody is watching any more — dropping it is what stops a stale
      // response from overwriting a newer one.
      if (controller.signal.aborted) return;
      this.value = value;
      this.error = undefined;
      this.failures = 0;
    } catch (e) {
      if (controller.signal.aborted) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.failures++;
    } finally {
      if (!controller.signal.aborted) {
        this.pending = false;
        this.inFlight = undefined;
        this.host.requestUpdate();
        this.schedule();
      }
    }
  }

  /**
   * Queue the next read, unless the tab is hidden — in which case
   * `onVisibilityChange` restarts the loop on return rather than a timer that
   * kept running while nobody was looking.
   */
  private schedule(): void {
    if (!this.connected || window.document.hidden) return;
    const delay =
      this.failures === 0
        ? this.intervalMs
        : Math.min(this.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
    this.timer = window.setTimeout(() => void this.run(), delay);
  }

  /**
   * An arrow rather than a method because it is a value handed to
   * `addEventListener` — it has to keep its `this` and stay identical between
   * `add` and `remove`.
   */
  private readonly onVisibilityChange = (): void => {
    if (window.document.hidden) this.cancel();
    else this.refresh();
  };
}
