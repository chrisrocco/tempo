import {useEffect, useState} from 'react';
import type {ServerHealth} from '../../src/protocol';
import {usePoll, formatDuration} from './rpc';
import {Registry} from './views/Registry';
import {Fleet} from './views/Fleet';
import {Executions} from './views/Executions';
import {RunDetail} from './views/RunDetail';

type Tab = 'workflows' | 'fleet' | 'executions';

/** `#/run/<id>` is the detail view; anything else is a tab name. */
function readHash(): {tab: Tab; runId?: string} {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('run/'))
    return {tab: 'executions', runId: decodeURIComponent(hash.slice(4))};
  if (hash === 'fleet' || hash === 'executions') return {tab: hash};
  return {tab: 'workflows'};
}

export function App() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const {data: health, error} = usePoll<ServerHealth>(
    () => ({method: 'health'}),
    5000,
  );

  const tabs: Array<{id: Tab; label: string; href: string}> = [
    {id: 'workflows', label: 'Workflows', href: '#/'},
    {id: 'fleet', label: 'Fleet', href: '#/fleet'},
    {id: 'executions', label: 'Executions', href: '#/executions'},
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">tempo</span>
          <span className="brand-sub">scenario dashboard</span>
        </div>
        <nav className="tabs">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={t.href}
              className={
                route.tab === t.id && route.runId === undefined
                  ? 'tab active'
                  : 'tab'
              }
            >
              {t.label}
            </a>
          ))}
        </nav>
        <div className="server-pill">
          {error !== undefined ? (
            <span className="dot bad" title={error}>
              server unreachable
            </span>
          ) : health === undefined ? (
            <span className="dot idle">connecting…</span>
          ) : (
            <span className="dot ok">
              {health.hostname ?? 'server'}:{health.port ?? '?'} · up{' '}
              {formatDuration(health.uptimeMs)} ·{' '}
              {health.durable ? 'durable' : 'in-memory'}
            </span>
          )}
        </div>
      </header>
      <main className="content">
        {route.runId !== undefined ? (
          <RunDetail workflowId={route.runId} />
        ) : route.tab === 'workflows' ? (
          <Registry />
        ) : route.tab === 'fleet' ? (
          <Fleet />
        ) : (
          <Executions />
        )}
      </main>
    </div>
  );
}
