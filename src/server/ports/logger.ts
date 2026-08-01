/**
 * @fileoverview
 * The port lifecycle facts are reported through. A `Logger` is called with an
 * event name and a bag of fields; what happens to them is the adapter's business
 * (`server/json_logger.ts` writes one JSON object per line).
 *
 * It is a port rather than a module anyone can import for the same reason the
 * history store is: writing to a stream is I/O, and the layering rules keep `server/`
 * importing only `protocol/`. A shared logging module reachable from every layer
 * would be the `utils/` this codebase deliberately does not have. Injected instead,
 * it is swappable, silent in tests by default, and impossible to reach for by
 * accident from the deterministic side.
 *
 * **Events are structured, never formatted.** No sentences, no interpolation — a
 * stable event name plus fields. That is what makes the log aggregatable later
 * without anyone parsing prose, and it is why the "metrics" decision could be
 * deferred to a choice of sink rather than a rewrite of every call site.
 *
 * Names are `subject.verb` in past tense (`activity.timed_out`), because a log
 * line records something that already happened.
 */

/** Structured detail attached to an event. Values must survive `JSON.stringify`. */
export type LogFields = Record<string, unknown>;

/** Where lifecycle events go. Injected; defaults to `silentLogger`. */
export interface Logger {
  (event: string, fields?: LogFields): void;
}

/**
 * The default. Tests and library embedders get silence unless they ask otherwise
 * — a framework that writes to stderr uninvited is a framework people wrap to
 * shut up.
 */
export const silentLogger: Logger = () => {};
