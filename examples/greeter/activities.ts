/**
 * @fileoverview
 * The activity half of the greeter worker: plain exported functions, and the only
 * place I/O is allowed. The export name is the registered activity name.
 *
 * The non-function export is deliberate — a real activities module carries
 * constants alongside its activities, and both `proxyActivities<typeof activities>`
 * and `Tempo.startWorker` must ignore them rather than choke on them.
 */

export const GREETING = 'Hello';

export function greet(name: string): string {
  return `${GREETING}, ${name}!`;
}
