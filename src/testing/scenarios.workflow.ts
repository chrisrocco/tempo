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
 * Every workflow here is described, because half the point of the harness is
 * giving a catalogue view something to show: a dashboard developer needs rows
 * with titles, descriptions and props, not five bare identifiers.
 *
 * The descriptions live in `SCENARIO_DESCRIPTORS` below rather than on the
 * functions, which is the one place in the repo that reads that way round. Two
 * rules meet here and leave no third option:
 *
 * - `createWorkflow` is the only way to describe a workflow, and it **registers**
 *   into the process-global registry at module load. This module is imported by
 *   `testing/index.ts`, the published test entrypoint, so declaring these would
 *   mean anyone importing the harness silently gets four scenario workflows
 *   folded into their own worker.
 * - Reaching the internal writer directly is what `tools/boundaries.ts` forbids:
 *   a workflow module may import `workflow.ts` and nothing else.
 *
 * So the fixtures carry their descriptions as data the harness merges when it
 * reports. The usual objection to a name-keyed map — a string that has to match a
 * function can drift silently — is answered here specifically: these names are
 * already strings in `SCENARIO_WORKFLOWS`, already what the harness starts them
 * by, and `spec/testing/scenarios.spec.ts` asserts the published catalogue
 * carries these exact titles. Drift fails a spec rather than going unnoticed.
 *
 * A workflow module, so it obeys the author entrypoint — imports only
 * `workflow.ts`, and hands its activities namespace to nothing but
 * `proxyActivities`. `tools/boundaries.ts` checks both.
 */

import * as scenarioActivities from './scenario_activities';
import {
  condition,
  proxyActivities,
  setHandler,
  waitForApproval,
  type ApprovalDecision,
} from '../workflow';
// Type-only, and erased — which is the whole reason a workflow module may reach
// past `workflow.ts` for them at all (`tools/boundaries.ts`). They buy the
// name-keyed map below a compiler.
import type {WorkflowDescriptor} from '../protocol';
import type {RegisteredScenarioName} from './scenarios';

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
export const release = 'release';

/**
 * The signal that settles the awaiting-approval execution.
 *
 * Exported for the consumer who wants to script the decision, but the fixture's
 * point is that nobody needs this constant: the parked state itself advertises
 * the name in `awaiting.signal`, and a dashboard that reads it from there is
 * exercising the whole affordance the scenario exists to demonstrate.
 */
export const decide = 'decide';

export async function scenarioCompletes(props: {
  value: string;
}): Promise<unknown> {
  return settling.scenario_succeed(props.value);
}

export async function scenarioFails(): Promise<unknown> {
  return settling.scenario_fail();
}

export async function scenarioParks(): Promise<string> {
  let released = false;
  setHandler(release, () => {
    released = true;
  });
  await condition(() => released);
  return 'released';
}

export async function scenarioRetries(): Promise<unknown> {
  return retrying.scenario_fail();
}

/**
 * Parks on `waitForApproval`, which is `scenarioParks` with the affordance the
 * approval pattern adds: the parked state carries `{kind: 'approval', signal,
 * detail}`, so a dashboard can render what is being asked and knows where to
 * send the answer. "Stays there" holds the same way — nothing decides it unless
 * someone does — and the result echoes the decision's attribution, so the
 * round trip is visible on the settled execution rather than only in history.
 */
export async function scenarioAwaitsApproval(): Promise<string> {
  const decision = await waitForApproval<ApprovalDecision>({
    signal: decide,
    detail: {
      what: 'Ship the pending release',
      requestedBy: 'scenario-harness',
    },
  });
  const by = decision.approvedBy ?? 'someone unnamed';
  return decision.approved ? `approved by ${by}` : `declined by ${by}`;
}

/**
 * What each scenario says about itself, keyed by the name it is registered under
 * — see the fileoverview for why this is data here rather than riding on the
 * functions.
 *
 * **`RegisteredScenarioName` is what keeps the map honest.** A name-keyed map is
 * the shape where a string drifts away from the thing it names, and that is the
 * objection the fileoverview answers. It is answered by the compiler rather than
 * by care: a mistyped key, and a scenario added without a description, are both
 * errors here. `undeployed` is excluded by that type because it is deliberately
 * never registered, so describing it would describe nothing.
 *
 * The titles themselves still need a spec — a type cannot know what a title
 * ought to say — and `spec/testing/scenarios.spec.ts` asserts every one of them
 * against the published catalogue.
 *
 * Not exported as a workflow: the harness filters its registry down to callables,
 * so this object is skipped by the same check that skips `release`.
 */
export const SCENARIO_DESCRIPTORS: Record<
  RegisteredScenarioName,
  WorkflowDescriptor
> = {
  scenarioCompletes: {
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
  },
  scenarioFails: {
    title: 'Fails immediately',
    description:
      'Runs one activity that throws, with no retries, so the execution settles as failed.',
  },
  scenarioParks: {
    title: 'Waits for a signal',
    description:
      'Parks on a condition that only a `release` signal makes true. Stays running until it gets one.',
  },
  scenarioRetries: {
    title: 'Retries an activity',
    description:
      'Runs an activity that always throws, backing off a minute between attempts. Stays running with its attempt count climbing.',
  },
  scenarioAwaitsApproval: {
    title: 'Waits for approval',
    description:
      'Parks on `waitForApproval`, so its parked state advertises {kind: "approval"} naming the `decide` signal. A decision payload carrying attribution settles it.',
  },
} as const;

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
