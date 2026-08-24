/**
 * `createHash`, for a browser, non-cryptographically.
 *
 * The engine's only use is `worker/workflow_reporter.ts`, which digests a
 * worker's manifest so the server can tell whether the copy it holds is still
 * the one the worker is running. The digest is compared for equality and
 * nothing else — it authenticates nothing and protects nothing — so FNV-1a is
 * an honest fit, and `node:crypto` was chosen there for being a builtin rather
 * than for being cryptographic.
 *
 * What it does have to be is **stable**: the same manifest must digest the same
 * way on every call, or a worker's report would look stale the moment it polled.
 */
class Fnv1aHash {
  private hash = 0x811c9dc5;

  update(data: string): this {
    for (let i = 0; i < data.length; i++) {
      this.hash ^= data.charCodeAt(i);
      // The FNV prime, by shifts, because a 32-bit multiply overflows a double.
      this.hash +=
        (this.hash << 1) +
        (this.hash << 4) +
        (this.hash << 7) +
        (this.hash << 8) +
        (this.hash << 24);
      this.hash >>>= 0;
    }
    return this;
  }

  digest(_encoding?: string): string {
    return this.hash.toString(16).padStart(8, '0');
  }
}

export function createHash(_algorithm: string): Fnv1aHash {
  return new Fnv1aHash();
}

export default {createHash};
