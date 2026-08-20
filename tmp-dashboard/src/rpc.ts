/**
 * The dashboard's whole client: one POST per question, straight off the
 * engine's own protocol types. Everything rendered is typed by
 * `src/protocol` — the point of the demo is that nothing here is invented.
 */
import type {RpcRequest, RpcResponse} from '../../src/protocol';
import {useEffect, useRef, useState} from 'react';

export async function rpc<T>(request: RpcRequest): Promise<T> {
  const res = await fetch('/rpc', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(request),
  });
  const body = (await res.json()) as RpcResponse;
  if (!body.ok) throw new Error(body.error);
  return body.value as T;
}

/** Poll a request every `intervalMs`, keeping the last good answer. */
export function usePoll<T>(
  make: () => RpcRequest,
  intervalMs = 2000,
  deps: unknown[] = [],
): {data: T | undefined; error: string | undefined} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const value = await rpc<T>(make());
        if (!alive.current) return;
        setData(value);
        setError(undefined);
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      alive.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {data, error};
}

export function formatAge(epochMs: number | undefined, now: number): string {
  if (epochMs === undefined) return '—';
  const ms = now - epochMs;
  if (ms < 0) return `in ${formatDuration(-ms)}`;
  return `${formatDuration(ms)} ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
