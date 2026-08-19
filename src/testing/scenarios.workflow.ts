/**
 * @fileoverview
 * The workflow bodies behind the named scenarios — one per state a dashboard has
 * to render, each the shortest thing that reaches that state and stays there.
 *
 * "Stays there" is the constraint that shapes all of them. A fixture that reaches
 * an interesting state and then leaves it is worse than no fixture, because it
 * depends on how quickly whoever is looking got there. So the parked one waits on
 * a signal that never arrives unless someone sends it, the retrying one backs off
 * for a minute at a time, and the wedged one fails its task forever.
 *
 * Every workflow here is `defineWorkflow`d, because half the point of the harness
 * is giving a catalogue view something to show: a dashboard developer needs rows
 * with titles, descriptions and props, not five bare identifiers.
 *
 * A workflow module, so it obeys the author entrypoint — imports only
 * `workflow.ts`, and hands its activities namespace to nothing but
 * `proxyActivities`. `tools/boundaries.ts` checks both.
 */

import * as scenarioActivities from './scenario_activities';
import {
  condition,
  defineSignal,
  defineWorkflow,
  proxyActivities,
  setHandler,
} from '../workflow';

/**
 * One attempt and no more, so the execution *settles* as failed rather than
 * sitting in backoff. The distinction is the whole difference between the
 * `settled-mixed` scenario and the `retrying` one, and it lives here.
 */
const settling = proxyActivities(scenarioActivities, {
  retry: {maximumAttempts: 1},
});

/**
 * A minute between attempts, which is long next to any dashboard's refresh and
 * short enough that a scenario left running does eventually move. A hundred
 * attempts is not a limit anyone will reach; it is there so the execution has a
 * defined end rather than retrying literally forever.
 */
const retrying = proxyActivities(scenarioActivities, {
  retry: {maximumAttempts: 100, initialIntervalMs: 60_000},
});

/** Sent to a parked execution to release it — the scenario's escape hatch. */
export const release = defineSignal('release');

export const scenarioCompletes = defineWorkflow({
  title: 'Completes immediately',
  description:
    'Runs one activity that returns straight away, then settles as completed.',
  props: {
    type: 'object',
    required: ['value'],
    properties: {
      value: {
        type: 'string',
        description: 'Echoed back as the execution result.',
      },
    },
  },
  async start(props: {value: string}): Promise<unknown> {
    return settling.scenario_succeed(props.value);
  },
});

export const scenarioFails = defineWorkflow({
  title: 'Fails immediately',
  description:
    'Runs one activity that throws, with no retries, so the execution settles as failed.',
  async start(): Promise<unknown> {
    return settling.scenario_fail();
  },
});

export const scenarioParks = defineWorkflow({
  title: 'Waits for a signal',
  description:
    'Parks on a condition that only a `release` signal makes true. Stays running until it gets one.',
  async start(): Promise<string> {
    let released = false;
    setHandler(release, () => {
      released = true;
    });
    await condition(() => released);
    return 'released';
  },
});

export const scenarioRetries = defineWorkflow({
  title: 'Retries an activity',
  description:
    'Runs an activity that always throws, backing off a minute between attempts. Stays running with its attempt count climbing.',
  async start(): Promise<unknown> {
    return retrying.scenario_fail();
  },
});

// There is deliberately no workflow here for the `stuck` scenario, and that is
// the fixture rather than an omission.
//
// A wedged execution is one the server cannot get commands back for, and the
// obvious way to write one — `throw` in the body — does not produce it. That was
// measured: a throwing body settles the execution as `failed` with the message on
// `failure`, which is an ordinary application error and a *terminal* state. What
// wedges an execution is the task failing before the body is reached at all, and
// the everyday cause of that is a workflow type no worker on the queue has
// registered — a deploy still rolling out.
//
// So `stuck` starts `SCENARIO_WORKFLOWS.undeployed`, which nothing in this module
// defines. Registering it would quietly delete the scenario.
