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
  background,
  byCursor,
  condition,
  executeChild,
  patched,
  pollForever,
  proxyActivities,
  setHandler,
  signalStream,
  signalWorkflow,
  sleep,
  startChild,
  startWorkflow,
  waitForApproval,
  workflowInfo,
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

/**
 * A short fuse for the agent's flaky code search: one failed attempt, one
 * quick retry, success — enough to put the whole retry vocabulary
 * (`activityFailed`, `activityRetryScheduled`, a second `activityStarted`)
 * into the history without holding the seed up.
 */
const flaky = proxyActivities(scenarioActivities, {
  retry: {maximumAttempts: 3, initialIntervalMs: 300},
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

// ── the bug-fix agent ────────────────────────────────────────────────────
// One long agentic run whose history shows every event family the engine can
// write. Each stage exists to put a specific kind of event on the timeline;
// the comments name which. It parks twice for a human — intake and metrics —
// which is where the seed leaves it and where the sandbox gets interactive.

/** The intake gate's signal: "is this bug actionable?" */
export const intake = 'intake';
/** The launch gate's signal: "do the metrics look right?" */
export const shipMetrics = 'shipMetrics';
/** CI's report back to the agent, sent by the ciWatcher child. */
export const ciStatus = 'ciStatus';
/** A review comment for the agent to resolve, sent by the reviewer child. */
export const reviewComment = 'reviewComment';
/** The agent's acknowledgement back to the reviewer, per resolved comment. */
export const commentAck = 'commentAck';

/** Tried in order; the last one is the one the harness confirms. */
const HYPOTHESES = [
  'stale idempotency key cached across sessions',
  'webhook applied before the charge row commits',
  'retry branch re-enters charge() without the dedup guard',
];

/**
 * Gathers one source of context for the agent — or fails to, which is the
 * point of the `unavailable` flavor: the parent tolerating a `childFailed` is
 * part of the story its history tells.
 */
export async function scenarioResearcher(props: {
  source: string;
  unavailable?: boolean;
}): Promise<string> {
  if (props.unavailable === true)
    throw new Error(`${props.source} is unavailable this week`);
  return settling.scenario_gather_context(props.source);
}

/**
 * Files review comments at the agent, spaced out, then finishes. The agent
 * acks each resolution back on `commentAck` — an ack landing after this has
 * completed is recorded undelivered, which is itself a state worth having on
 * display.
 */
export async function scenarioReviewer(props: {
  comments: string[];
  gapMs: number;
}): Promise<string> {
  const parent = workflowInfo().parent;
  if (parent === undefined) return 'no parent to review';
  for (const comment of props.comments) {
    await sleep(props.gapMs);
    signalWorkflow(parent.workflowId, reviewComment, comment);
  }
  return `${props.comments.length} comments filed`;
}

/** Watches CI, reports green once, and is done. */
export async function scenarioCiWatcher(props: {
  settleMs: number;
}): Promise<string> {
  const parent = workflowInfo().parent;
  if (parent === undefined) return 'no parent to report to';
  await sleep(props.settleMs);
  signalWorkflow(parent.workflowId, ciStatus, {green: true, checks: 42});
  return 'CI green';
}

/**
 * The agent's dead-man switch while CI runs: parks until cancelled. The
 * cancellation is the fixture — `childCancelRequested` in the parent,
 * `cancelRequested` here — and standing down cleanly instead of failing shows
 * a workflow *catching* its cancellation.
 */
export async function scenarioWatchdog(): Promise<string> {
  try {
    await condition(() => false, {
      awaiting: {kind: 'watchdog', detail: 'pages a human if CI hangs'},
    });
  } catch {
    return 'stood down — CI settled first';
  }
  return 'unreachable';
}

/**
 * The whole arc: fetch → gather context (one source fails) → intake gate →
 * hypothesis loop → draft → CI + review comments under a watchdog → land →
 * ramp → metrics gate → launch and clean up.
 */
export async function scenarioBugfixAgent(props: {
  bugId: string;
}): Promise<string> {
  const me = workflowInfo().workflowId;

  // Stage: fetch bug details. [activityScheduled/Started/Completed]
  const bug = await settling.scenario_fetch_bug(props.bugId);

  // Stage: context gathering — two researchers in parallel, and the incident
  // archive is down. [childStarted, childCompleted, childFailed]
  const codebase = executeChild<string>('scenarioResearcher', {
    props: {source: 'payments service history'},
    workflowId: `${me}-context-code`,
  });
  // The catch is attached at creation, not at the later await: the archive
  // fails while the agent is still parked on the codebase researcher, and a
  // rejection with no handler yet attached is an unhandled rejection even
  // though one was coming.
  const archive = executeChild<string>('scenarioResearcher', {
    props: {source: 'incident archive', unavailable: true},
    workflowId: `${me}-context-archive`,
  }).catch(
    (e: unknown) => `skipped: ${e instanceof Error ? e.message : String(e)}`,
  );
  const context = await codebase;
  const archiveNotes = await archive;

  // Stage: search the code — first attempt times out, retry succeeds.
  // [activityRetryScheduled, a second activityStarted]
  const trace = await flaky.scenario_search_code(props.bugId);

  // Stage: try the repro bot, which is down, and proceed without it. A
  // *retried* activity never writes `activityFailed` — that event is the
  // terminal completion — so a tolerated hard failure is what puts one in the
  // record. [activityFailed]
  const repro = await settling
    .scenario_auto_repro()
    .catch(
      (e: unknown) =>
        `no auto-repro: ${e instanceof Error ? e.message : String(e)}`,
    );

  // Stage: intake gate — a human answers "is this bug actionable?".
  // [conditionParked with awaiting, signal] The seed leaves the run parked here.
  const intakeDecision = await waitForApproval<ApprovalDecision>({
    signal: intake,
    detail: {
      question: 'Is this bug actionable?',
      bug: bug.title,
      context: [context, archiveNotes],
      evidence: trace,
      repro,
    },
  });
  if (!intakeDecision.approved)
    return `closed at intake by ${intakeDecision.approvedBy ?? 'someone unnamed'} — not actionable`;

  // Stage: hypothesis loop, under a version marker. [patchRecorded,
  // timerStarted/timerFired between rounds]
  patched('bugfix-agent-hypothesis-loop-v2');
  let confirmed = HYPOTHESES[HYPOTHESES.length - 1]!;
  for (let round = 1; round <= HYPOTHESES.length; round++) {
    const verdict = await settling.scenario_test_hypothesis({
      round,
      hypothesis: HYPOTHESES[round - 1]!,
      confirmed: round === HYPOTHESES.length,
    });
    if (verdict.confirmed) {
      confirmed = verdict.hypothesis;
      break;
    }
    await sleep(350);
  }

  // Stage: draft the fix.
  const pr = await settling.scenario_draft_fix(confirmed);

  // Stage: CI settles while comments get resolved, under a watchdog.
  // [childCancelRequested, workflowSignaled (acks), signal (comments + CI),
  //  two more childCompleted, and a second parked condition]
  let ciGreen = false;
  setHandler(ciStatus, (status: {green: boolean}) => {
    ciGreen = status.green;
  });
  const watchdog = startChild('scenarioWatchdog', {
    workflowId: `${me}-watchdog`,
  });
  const reviewer = executeChild<string>('scenarioReviewer', {
    props: {
      comments: ['nit: name the guard constant', 'add a webhook-race test'],
      gapMs: 500,
    },
    workflowId: `${me}-review`,
  });
  const ci = executeChild<string>('scenarioCiWatcher', {
    props: {settleMs: 1600},
    workflowId: `${me}-ci`,
  });
  const resolved: string[] = [];
  const comments = background(async () => {
    for await (const comment of signalStream<string>(reviewComment, {
      until: condition(() => ciGreen),
    })) {
      resolved.push(await settling.scenario_resolve_comment(comment));
      signalWorkflow(`${me}-review`, commentAck, comment);
    }
  });
  await condition(() => ciGreen, {
    awaiting: {kind: 'ci', detail: `waiting for CI to settle on ${pr}`},
  });
  await comments.done;
  comments.throwIfFailed();
  await Promise.all([reviewer, ci]);
  watchdog.cancel();

  // Stage: land, then ramp. [more timers and activities]
  const landed = await settling.scenario_land_fix(pr);
  for (const pct of [25, 50, 100]) {
    await sleep(350);
    await settling.scenario_set_ramp(pct);
  }

  // Stage: metrics gate — a human signs off on the numbers.
  const shipDecision = await waitForApproval<ApprovalDecision>({
    signal: shipMetrics,
    detail: {
      question: 'Ramped to 100% — do the metrics look right to launch?',
      landed,
      commentsResolved: resolved.length,
      errorRate: 'double-charges: 0.31% → 0.00%',
      latency: 'p95 checkout unchanged',
    },
  });
  if (!shipDecision.approved) {
    await settling.scenario_set_ramp(0);
    return `rolled back by ${shipDecision.approvedBy ?? 'someone unnamed'} — metrics not accepted`;
  }

  // Stage: launch — announce via an external start that outlives this run —
  // and clean up. [workflowStarted]
  startWorkflow(`${me}-announcement`, 'scenarioCompletes', {
    props: {value: `🎉 ${props.bugId} fixed and launched: ${landed}`},
  });
  const swept = await settling.scenario_cleanup();
  return `${props.bugId} fixed — ${landed}, ramped to 100%, ${swept}`;
}

/**
 * A poller in its natural habitat: `pollForever` + `byCursor` over a stream,
 * relaying each new item by claiming a child with a domain-derived id.
 *
 * This is the fixture for the engine's signature move. Watch it and three
 * things happen that no other scenario shows: `runId` climbs — the loop
 * continues-as-new every time the cursor moves, so history is shed as fast as
 * it grows; the carryover cursor (`pollForever.state`) advances in `describe`;
 * and `scenario-feed-item-<n>` executions accumulate, each claimed by an
 * explicit id so a replayed cycle starts no second child. `startFrom: 'new'`
 * is on display too: the first cycle baselines the feed and reports nothing.
 */
export async function scenarioFeedWatcher(): Promise<never> {
  return pollForever({
    everyMs: 2000,
    differ: byCursor((item: {id: number; title: string}) => item.id),
    poll: (after) => settling.scenario_poll_feed(after),
    startFrom: 'new',
    onAdded: (item) => {
      startChild('scenarioCompletes', {
        props: {value: `processed ${item.title}`},
        workflowId: `scenario-feed-item-${item.id}`,
      });
    },
  });
}

/**
 * The deploy switch behind `scenarioDiverges` — mutable host state a workflow
 * reads, which is precisely the determinism violation being modeled. A real
 * fleet does this by rolling a new binary; a fixture in one process does it by
 * flipping this object between tasks. Nothing else here may imitate it: every
 * other scenario workflow is honestly deterministic, and this one is
 * deliberately, instructively not.
 */
export const DEPLOYED = {version: 1};

/**
 * Wedges on `NondeterminismError` once the "deploy" lands.
 *
 * Version 1 parks on an hour-long timer, so history's seq 0 is a
 * `timerStarted` marker. Version 2 skips the wait and reaches for an activity
 * first — so the next replay issues `scheduleActivity` at seq 0, history
 * disagrees, and the task fails with the one error `reset` exists to fix.
 * The retry loop keeps failing identically, which is what makes it a fixture:
 * running, `taskFailures` climbing, unrecoverable by anything but a rewind.
 */
export async function scenarioDiverges(): Promise<string> {
  if (DEPLOYED.version === 1) {
    await sleep(60 * 60 * 1000);
    return 'v1 report sent, an hour late';
  }
  return settling.scenario_succeed(
    'v2 report sent — no wait',
  ) as Promise<string>;
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
  scenarioBugfixAgent: {
    title: 'Fixes a bug, end to end',
    description:
      'An agentic run with every event family on one timeline: fetches a bug, gathers context (one source fails), retries a flaky search, asks a human at intake, loops hypotheses, drafts a fix, resolves review comments while CI settles under a watchdog, lands, ramps, asks a human about metrics, then launches and cleans up.',
    props: {
      type: 'object',
      required: ['bugId'],
      properties: {
        bugId: {type: 'string', description: 'The bug being fixed.'},
      },
    },
  },
  scenarioResearcher: {
    title: 'Gathers context',
    description:
      "One research source for the bug-fix agent. The 'unavailable' flavor throws, so the parent shows a tolerated childFailed.",
  },
  scenarioReviewer: {
    title: 'Files review comments',
    description:
      'Signals review comments at its parent on a cadence, then completes.',
  },
  scenarioCiWatcher: {
    title: 'Watches CI',
    description: 'Sleeps until CI settles, reports green to its parent once.',
  },
  scenarioWatchdog: {
    title: 'Watchdog',
    description:
      'Parks until cancelled — the dead-man switch the bug-fix agent stands down once CI is green.',
  },
  scenarioFeedWatcher: {
    title: 'Watches a feed',
    description:
      'pollForever over a byCursor stream: rolls its history over each time the cursor moves, carries the cursor in carryover, and claims a scenario-feed-item child per new submission.',
  },
  scenarioDiverges: {
    title: 'Diverges after a deploy',
    description:
      'Version 1 parked on a timer; version 2 reaches for an activity first. The replay disagrees with history, the task fails with NondeterminismError forever, and `reset` is the recovery.',
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
