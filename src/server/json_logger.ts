/**
 * @fileoverview
 * The Logger adapter that writes JSON Lines — one object per line, one line per
 * event. Chosen over a metrics client because it needs no dependency, no agent,
 * and no decision about a sink: `jq`, `grep`, and every log pipeline already read
 * it, and a real metrics backend can consume it later without any call site
 * changing (ROADMAP Phase 7).
 *
 * Writes to **stderr**, deliberately. stdout carries the readiness lines that
 * `tempo up`, supervisors, and the integration specs parse (`LISTENING <port>`,
 * `WORKER_READY ...`); interleaving log objects there would break them.
 *
 * The timestamp is `Date.now()`-derived and the field order is fixed, so lines
 * sort and diff predictably.
 */

import type {LogFields, Logger} from './ports/logger';

/**
 * @param write where a finished line goes — injectable so specs can assert on
 * emitted events without capturing a process stream.
 */
export function createJsonLogger(
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  return (event: string, fields: LogFields = {}) => {
    write(
      `${JSON.stringify({ts: new Date().toISOString(), event, ...fields})}\n`,
    );
  };
}
