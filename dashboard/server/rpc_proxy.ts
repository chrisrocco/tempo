/**
 * @fileoverview
 * Forwarding the browser's RPC calls to the engine.
 *
 * This is what lets the dashboard be a separate thing without the engine
 * learning that browsers exist. The page is served from this origin and calls
 * back to this origin; this process forwards those calls onward. The browser
 * makes exactly one cross-origin request, which is to say none.
 *
 * ## Why a proxy rather than CORS
 *
 * The alternative is letting the page call the engine directly and teaching the
 * engine to permit it — a preflight handler and `Access-Control-*` headers on
 * the RPC. That is engine surface existing solely for the dashboard's benefit,
 * which is the coupling this split exists to remove. A proxy keeps the
 * concession on the side that wants it.
 *
 * It also preserves the property that made co-serving attractive in the first
 * place: one origin to reach, and no configuration for an operator to get
 * wrong.
 *
 * ## The engine's transport is unauthenticated, and this does not change that
 *
 * Anything that can reach this process can drive the engine through it, up to
 * and including terminating executions. That was already true of the RPC port
 * and is why both bind loopback by default. Putting a proxy in front adds a
 * hop, not a control — it is not a security boundary and must not be read as
 * one.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';

/** How long to wait on the engine before giving up on one call. */
const TIMEOUT_MS = 30_000;

/**
 * Read a request body to a string.
 *
 * Bounded, because this is an unauthenticated listener and an unbounded read is
 * how one becomes a memory exhaustion bug. The cap is far above any real RPC
 * request — those are a method name and a few arguments.
 */
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Forward one RPC call to `engineUrl` and pipe the answer back.
 *
 * A failure to reach the engine is reported in the RPC's own envelope shape
 * rather than as an HTTP error, because that is what the dashboard's client
 * already knows how to display: it turns `{ok: false}` into a message on the
 * page. An HTTP 502 would surface as "server returned 502", which tells an
 * operator less than "connect ECONNREFUSED" does.
 */
export async function proxyRpc(
  req: IncomingMessage,
  res: ServerResponse,
  engineUrl: string,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (e) {
    sendEnvelope(res, errorMessage(e));
    return;
  }

  try {
    const upstream = await fetch(engineUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {'content-type': 'application/json'});
    res.end(text);
  } catch (e) {
    sendEnvelope(
      res,
      `cannot reach the engine at ${engineUrl} — ${errorMessage(e)}`,
    );
  }
}

/** The RPC's failure envelope, with HTTP 200 — see the note on `proxyRpc`. */
function sendEnvelope(res: ServerResponse, error: string): void {
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify({ok: false, error}));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
