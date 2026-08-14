/**
 * @fileoverview
 * `workflow-engine/client` — the entrypoint a dashboard, CLI, or desktop app
 * imports to reach a running server.
 *
 * Two properties, and neither is about behaviour. What the client *does* is
 * covered by `spec/client/client.spec.ts`; what this file pins is that the
 * published path keeps pointing at a file that composes a client at all.
 *
 * The third property — that nothing reachable from here pulls a Node builtin or
 * a workflow module into a consumer's bundle — is the browser-safety rule in
 * `tools/boundaries.ts`, exercised by `spec/architecture.spec.ts`. It lives there
 * because it is a question about the import graph, and because a rule the lint
 * step runs catches it in the commit that breaks it rather than in a consumer's
 * build weeks later.
 */

import * as fs from 'node:fs';
import {createRemoteClient, createRemoteService} from '../../src/remote_client';
import {repoPath} from '../support/repo_root';

describe('the client entrypoint', () => {
  /**
   * The published path and the file are declared in two places that nothing else
   * ties together: a rename that updates the import graph and forgets
   * `package.json` leaves every consumer resolving a path that is gone, and the
   * suite would otherwise be entirely happy about it.
   */
  it('is the file the exports map publishes as workflow-engine/client', () => {
    const manifest = JSON.parse(
      fs.readFileSync(repoPath('package.json'), 'utf8'),
    ) as {exports: Record<string, string>};

    expect(manifest.exports['./client']).toBe('./src/remote_client.ts');
  });

  it('composes a client from a base URL without reaching the network', () => {
    const client = createRemoteClient(
      createRemoteService('http://127.0.0.1:1'),
    );

    // The server-wide reads a dashboard is built on, plus `health`, which is the
    // one method `createRemoteClient` adds over `createClient`.
    expect(typeof client.start).toBe('function');
    expect(typeof client.list).toBe('function');
    expect(typeof client.queues).toBe('function');
    expect(typeof client.counts).toBe('function');
    expect(typeof client.health).toBe('function');
  });

  it('hands out an execution handle from the same entrypoint', () => {
    const client = createRemoteClient(
      createRemoteService('http://127.0.0.1:1'),
    );

    expect(typeof client.getHandle('any-id').describe).toBe('function');
  });
});
