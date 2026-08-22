/**
 * @fileoverview
 * The tracker connector's fixture protocol — the shape every real connector's
 * `fixtures.ts` follows, here against the in-memory fake so the harness's
 * lifecycle (sweep → provision → cases → destroy) is exercised in CI.
 *
 * The fixture unit is a **project**: cheap to create, contains everything a
 * test makes, archivable in one call, and tagged `cnx-test` so the janitor can
 * find what a crashed run left behind. "What is your disposable container?" is
 * the first question a connector's fixtures file answers; this is tracker's.
 */

import type {LiveFixtures} from '../../../src/connectors';
import {fakeTracker} from './tracker';

export interface TrackerFx {
  projectKey: string;
}

/** The sweepable marker every provisioned project carries. */
export const FIXTURE_LABEL = 'cnx-test';

function projectKeyFor(ns: string): string {
  return `CX${ns
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12)}`;
}

export const trackerFixtures: LiveFixtures<TrackerFx> = {
  provision(ns) {
    const key = projectKeyFor(ns);
    fakeTracker.createProject({
      key,
      name: `${FIXTURE_LABEL} ${ns}`,
      labels: [FIXTURE_LABEL],
    });
    return {projectKey: key};
  },
  destroy(ns) {
    fakeTracker.archiveProject(projectKeyFor(ns));
  },
  sweep(olderThanMs) {
    const leaked = fakeTracker.listProjects({
      label: FIXTURE_LABEL,
      createdBeforeMs: Date.now() - olderThanMs,
    });
    for (const project of leaked) fakeTracker.archiveProject(project.key);
    return leaked.length;
  },
};
