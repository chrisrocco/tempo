/**
 * @fileoverview
 * The one error vocabulary every connector speaks.
 *
 * Handlers map transport failures into a closed taxonomy; workflow authors catch
 * one type with a `kind` they can switch on. Retryability is fixed per kind —
 * `unavailable` and `upstream` retry, everything else fails fast — because the
 * engine's retry policy is attempts-and-backoff only, so classification has to
 * live here.
 *
 * `drift` is the kind schema validation raises when a *response* no longer
 * matches the connector's declared output: not the caller's fault (`invalid`),
 * not the service being down (`unavailable`) — the contract itself has moved.
 * It is non-retryable: the same response will mis-parse every time.
 *
 * The envelope is how a non-retryable failure crosses the activity boundary
 * without triggering the engine's retry: the activity *completes* with
 * `{ok: false, error}` and the workflow-side proxy rethrows it typed.
 */

export type ConnectorErrorKind =
  | 'invalid' // the caller's input failed validation or the service rejected it
  | 'notFound' // the addressed resource does not exist
  | 'conflict' // the operation contradicts current state
  | 'denied' // authn/authz failure
  | 'unavailable' // the service cannot be reached right now — retryable
  | 'upstream' // the service failed internally — retryable
  | 'drift'; // the response no longer matches the declared schema

const RETRYABLE: Record<ConnectorErrorKind, boolean> = {
  invalid: false,
  notFound: false,
  conflict: false,
  denied: false,
  unavailable: true,
  upstream: true,
  drift: false,
};

/** The wire form of a non-retryable failure: JSON-safe, lives in history. */
export interface ConnectorErrorEnvelope {
  readonly kind: ConnectorErrorKind;
  readonly message: string;
  readonly details?: unknown;
}

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly details?: unknown;

  constructor(
    kind: ConnectorErrorKind,
    message: string,
    options: {details?: unknown} = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
    this.details = options.details;
    // keep `instanceof` working when compiled down to ES5-ish targets, as
    // `core/errors` and `VersionConflictError` already do. Not cosmetic here:
    // `connector.ts` uses `instanceof` to decide that a failure is
    // non-retryable and must cross the activity boundary as an envelope, so a
    // broken prototype chain silently turns every connector error back into a
    // retryable one and the engine retries what was meant to fail fast.
    Object.setPrototypeOf(this, ConnectorError.prototype);
  }

  get retryable(): boolean {
    return RETRYABLE[this.kind];
  }

  toEnvelope(): ConnectorErrorEnvelope {
    return {kind: this.kind, message: this.message, details: this.details};
  }

  static fromEnvelope(e: ConnectorErrorEnvelope): ConnectorError {
    return new ConnectorError(e.kind, e.message, {details: e.details});
  }
}
