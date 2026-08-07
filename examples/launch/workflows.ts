/**
 * @fileoverview
 * A CL-to-full-launch pipeline, as three workflows. The domain is Google-shaped —
 * land a change, guard it behind an experiment flag, ramp traffic to it over two
 * weeks with humans in the loop, then clean up — but the shape is the general one:
 * **a stable spine of stages, with a reconcile loop inside the stages that need
 * one, and a supervisor branch running beside them.**
 *
 * Read the three in this order. `landCl` is the reconciler and the hardest;
 * `rampExperiment` is a loop over a policy table; `launch` is the spine that
 * sequences them and is deliberately the most boring code here.
 *
 * ## Why three workflows and not one
 *
 * Every reason is about the two weeks this thing is alive for.
 *
 * **History stays bounded without anyone thinking about it.** A child's history
 * dies when the child completes; the spine keeps one `childCompleted` event per
 * phase and is a few dozen events across the whole launch. One flat workflow
 * would need a continue-as-new strategy, and continue-as-new carries only
 * carryover — small, and fixed for the run.
 *
 * **`workflowId` turns "start a phase" into "make sure this phase exists".** Each
 * child claims an id drawn from the domain — `land:${cl}`, `ramp:${experiment}` —
 * so kicking the pipeline off twice for one CL produces one landing attempt
 * rather than two agents fighting over the same patch set. That check lives at
 * the server, not in this file's bookkeeping, which is what makes it hold across
 * the spine replaying, restarting, or simply being asked twice.
 *
 * The claim dedupes **effects, not waiters**. A child reports its completion to
 * one parent, so if two live pipelines claim the same child id, the work happens
 * once — which is the property that matters — but only the parent that claimed it
 * second is resumed, and the first parks forever. Pinned in the spec beside this
 * example. Until that is fixed, treat a claimed id as owned by one pipeline: run
 * at most one `launch` per CL, and let the duplicate-start rejection be what
 * enforces it.
 *
 * **Workflow code cannot be redeployed under a live execution.** There is no
 * versioning primitive, so editing a workflow function that something is midway
 * through diverges its replay from its history. The mitigation is structural and
 * it is why this file looks the way it does: *the workflows are a dumb spine and
 * all the judgement lives in activities.* Which analyzer findings block a submit,
 * what a comment means, whether an analysis is clean — every one of those is an
 * activity, and activity code is not replayed, so it can be redeployed freely
 * while a launch is in flight. When you feel the urge to put a policy decision in
 * here, that is the urge to make this file un-redeployable for two weeks.
 *
 * The ramp policy is the same argument in data form: it arrives as a workflow
 * *argument* rather than a constant this module closes over, so changing the
 * stages does not touch code that live executions replay against.
 *
 * ## The types are declared here, not imported
 *
 * A workflow module may import exactly one thing — the author entrypoint — which
 * is what makes the determinism boundary structural rather than a convention.
 * That includes type-only imports, so the activity interface and the domain types
 * this pipeline speaks are declared here and *implemented* elsewhere. The two
 * halves are tied together where they are composed, in the worker entrypoint,
 * which is the one file allowed to see both.
 */

import {
  background,
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  proxyActivities,
  signalStream,
  sleep,
  workflowInfo,
} from '../../src/workflow';

// ── the domain ─────────────────────────────────────────────────────────────

/** An analyzer or reviewer objection standing between a CL and submission. */
export interface Finding {
  id: string;
  kind: 'lint' | 'analyzer' | 'test';
  message: string;
}

/** A comment on the CL or on the tracking bug. */
export interface Comment {
  id: string;
  author: string;
  body: string;
  /** Where it landed, so the reply goes back to the same place. */
  on: 'cl' | 'bug';
}

/**
 * What the supervisor decided a comment calls for. Splitting the decision from
 * the edit is what lets two lines of control share one CL — see `landCl`.
 */
export interface Directive {
  /** A reply to post, if the comment wanted an answer. */
  reply?: string;
  /** An edit to fold into the next reconcile pass, if it wanted a change. */
  edit?: string;
  /** Stop trying to land: the comment was a request to abandon. */
  abandon?: boolean;
}

/** Why a submit attempt did not take. Empty `blockers` with `submitted: false` means "not yet approved". */
export interface SubmitResult {
  submitted: boolean;
  blockers: string[];
}

/** One rung of the ramp. The whole policy is a list of these, passed in as an argument. */
export interface RampStage {
  /** Percentage of traffic this rung serves. */
  pct: number;
  /** How long to hold here once the ramp lands. */
  holdMs: number;
  /**
   * Signal name that must arrive before ramping *to* this rung. Each gate gets
   * its own name rather than sharing one `approval`, so an approval that races
   * ahead of the gate that wants it cannot be consumed by the wrong one.
   */
  gate?: string;
  /** What to do once the hold ends: snapshot and report, or run the analysis pass. */
  then?: 'report' | 'analyze';
}

export interface Metrics {
  /** True when a guardrail metric has regressed past its threshold. */
  regressed: boolean;
  reason: string;
}

export interface AnalysisResult {
  clean: boolean;
  summary: string;
}

/**
 * Everything this pipeline does to the outside world.
 *
 * Read it as the list of things that are allowed to change while a launch is
 * running. Note how many of them are `ensure`-shaped: activities are delivered
 * at-least-once by contract, so an activity that *asserts a state* is safe to run
 * twice where one that *applies a delta* is not.
 */
export interface LaunchActivities {
  // landing a CL
  getBlockingFindings(cl: string): Promise<Finding[]>;
  triageComment(cl: string, comment: Comment): Promise<Directive>;
  applyEdits(cl: string, edits: string[]): Promise<void>;
  postReplies(cl: string, replies: string[]): Promise<void>;
  trySubmit(cl: string): Promise<SubmitResult>;
  abandonCl(cl: string, reason: string): Promise<void>;

  // the experiment
  detectExperimentFlag(cl: string): Promise<string | null>;
  draftExperimentCl(
    flag: string,
    policy: RampStage[],
    owner: string,
  ): Promise<string>;
  experimentForFlag(flag: string): Promise<string>;
  ensureRampedTo(experiment: string, pct: number): Promise<number>;
  readGuardrails(experiment: string): Promise<Metrics>;
  snapshotResults(experiment: string): Promise<string>;
  analyzeResults(experiment: string): Promise<AnalysisResult>;

  // the humans
  sendReport(owner: string, subject: string, body: string): Promise<void>;
  requestApproval(
    owner: string,
    topic: string,
    signalName: string,
  ): Promise<void>;
  notifyOwner(owner: string, message: string): Promise<void>;
  closeBug(bug: string, resolution: string): Promise<void>;

  // cleanup
  draftCleanupCl(flag: string, owner: string): Promise<string>;
}

/**
 * Retries are generous because every activity here talks to a code-review or
 * experiment service over a network, and the failure that matters — a service
 * being down for a minute — is exactly the one a retry fixes. The start-to-close
 * bound is what keeps a hung call from being redelivered into a second
 * concurrent run of the same edit.
 */
const act = proxyActivities<LaunchActivities>({
  retry: {
    maximumAttempts: 5,
    initialIntervalMs: 1_000,
    maximumIntervalMs: 30_000,
  },
  startToCloseTimeoutMs: 60_000,
});

// ── signals ────────────────────────────────────────────────────────────────

/**
 * A comment arrived. Fed by a webhook adapter on the review system, which signals
 * `land:${cl}` — a workflow cannot signal anything itself, so the push direction
 * always enters through the client.
 */
export const commentPosted = defineSignal('commentPosted');

/** Stop the ramp and roll traffic back. Deliberately a signal and not a cancellation — see `rampExperiment`. */
export const haltRamp = defineSignal('haltRamp');

// ── 1. landCl — the reconciler ─────────────────────────────────────────────

export interface LandRequest {
  cl: string;
  /** How long between reconcile passes. */
  pollMs: number;
}

/** How a landing attempt ended. */
export type LandOutcome = 'submitted' | 'abandoned';

/**
 * Drive one CL to submitted, reconciling it against two sources of objection:
 * analyzer findings, which are *polled* because the analyzer has no idea this
 * workflow exists, and comments, which are *pushed* as signals by a webhook.
 *
 * ## Two lines of control, one CL
 *
 * The supervisor runs on its own branch beside the main loop, because a comment
 * can arrive at any moment and the main loop spends most of its life asleep. But
 * both lines want to edit the same CL, and letting them both do it produces patch
 * set races in the review system — which the engine will not save you from,
 * because it is not a bug in the workflow.
 *
 * So the branch **decides** and the main loop **applies**. The supervisor triages
 * a comment into a `Directive` and pushes it onto a plain local array; the next
 * reconcile pass drains that array and issues one edit. One writer, and the
 * coordination between the branches is an ordinary variable rather than anything
 * the engine had to provide.
 *
 * That works under replay because locals are rebuilt from scratch on every replay
 * pass, and the signals that repopulate them arrive from history in the order
 * they originally did. The interleaving reproduces because it is derived entirely
 * from recorded events.
 */
export async function landCl(req: LandRequest): Promise<LandOutcome> {
  let finished = false;
  let abandonReason = '';
  const edits: string[] = [];
  const replies: string[] = [];

  const supervisor = background(async () => {
    for await (const comment of signalStream<Comment>(commentPosted, {
      until: condition(() => finished),
      // 'start' rather than the default: a comment posted between the CL being
      // drafted and this workflow starting is still a comment about this CL.
      from: 'start',
    })) {
      const directive = await act.triageComment(req.cl, comment);
      if (directive.reply) replies.push(directive.reply);
      if (directive.edit) edits.push(directive.edit);
      if (directive.abandon) {
        abandonReason = `requested by ${comment.author}`;
      }
    }
  });

  try {
    while (true) {
      // A branch that died must not let the workflow quietly succeed: a
      // supervisor that threw means comments are no longer being answered, and
      // landing a CL while ignoring its reviewers is worse than stopping.
      supervisor.throwIfFailed();

      if (abandonReason) {
        await act.abandonCl(req.cl, abandonReason);
        return 'abandoned';
      }

      // Drain both queues before touching the CL, so one pass carries everything
      // known so far rather than one edit per comment.
      const pendingReplies = replies.splice(0);
      const pendingEdits = edits.splice(0);
      if (pendingReplies.length > 0)
        await act.postReplies(req.cl, pendingReplies);

      const findings = await act.getBlockingFindings(req.cl);
      const work = [...pendingEdits, ...findings.map(describeFinding)];
      if (work.length > 0) await act.applyEdits(req.cl, work);

      const result = await act.trySubmit(req.cl);
      if (result.submitted) return 'submitted';

      await sleep(req.pollMs);

      // Rolling over at a *clean checkpoint* — nothing triaged and unapplied,
      // nothing found and unfixed. Mid-reconciliation the queues above are the
      // only record that a comment was ever triaged, and they do not survive the
      // rollover; here there is nothing to lose. A CL that sits unsubmitted for
      // a week is the case this exists for.
      if (
        workflowInfo().continueAsNewSuggested &&
        edits.length === 0 &&
        replies.length === 0
      ) {
        // Drain the branch before shedding history, then halt: `continueAsNew`
        // never resolves, so nothing below it — including the `finally` — runs.
        finished = true;
        await supervisor.done;
        return continueAsNew(req);
      }
    }
  } finally {
    // Every exit path releases the branch and drains it, including an exception
    // unwinding through here. Without the drain, a workflow could complete while
    // a triage activity was still in flight.
    finished = true;
    await supervisor.done;
  }
}

function describeFinding(finding: Finding): string {
  return `${finding.kind}:${finding.id} ${finding.message}`;
}

// ── 2. rampExperiment — desired state vs. observed ─────────────────────────

export interface RampRequest {
  experiment: string;
  owner: string;
  policy: RampStage[];
  /** How often to check guardrails while holding at a stage. */
  guardrailMs: number;
  /** How long a gate waits for a human before giving up. */
  approvalTimeoutMs: number;
}

export interface RampOutcome {
  status: 'launched' | 'halted' | 'timedOut';
  /** The percentage traffic was left at. */
  pct: number;
  detail: string;
}

/**
 * Walk the policy, rung by rung, with humans gating the last two and guardrails
 * watching throughout.
 *
 * ## Halt is a signal, not a cancellation
 *
 * This is the one non-obvious decision in the file, and it is forced by the
 * engine. Cancelling a run marks its context cancelled, and from that moment
 * *every* primitive rejects immediately — so a `finally` block cannot run the
 * rollback activity, and an experiment cancelled at 50% stays at 50% forever.
 * Compensation needs a live context.
 *
 * So an abort arrives as `haltRamp`, the loop breaks, and the rollback below runs
 * on a context that is still allowed to do work. Cancellation and `terminate`
 * remain available as the operator's break-glass, with the understood cost that
 * break-glass leaves traffic where it was.
 */
export async function rampExperiment(req: RampRequest): Promise<RampOutcome> {
  let finished = false;
  let halted = '';
  let pct = 0;
  let analysis: AnalysisResult | undefined;

  const halter = background(async () => {
    for await (const signal of signalStream<{reason: string}>(haltRamp, {
      until: condition(() => finished),
    })) {
      if (!halted) halted = signal.reason;
    }
  });

  try {
    for (const stage of req.policy) {
      halter.throwIfFailed();
      if (halted) break;

      if (stage.gate) {
        // The analysis from the previous rung gates this one: "if clean, ask for
        // approval" means an unclean analysis never reaches a human at all.
        if (analysis && !analysis.clean) {
          halted = `analysis not clean: ${analysis.summary}`;
          break;
        }
        const decision = await awaitApproval(req, stage, () => halted);
        // A halt that arrived while the gate was open ends the gate rather than
        // waiting it out, and falls through to the rollback below.
        if (decision === 'halted') break;
        if (decision === 'declined') {
          halted = `approval declined for ${stage.pct}%`;
          break;
        }
        if (decision === 'timedOut') {
          return {
            status: 'timedOut',
            pct,
            detail: `no decision on ramp to ${stage.pct}%`,
          };
        }
      }

      // Not "ramp to" but "ensure ramped to": the activity reads what the
      // experiment service is actually serving and writes only on drift, so a
      // redelivered task converges instead of double-applying.
      pct = await act.ensureRampedTo(req.experiment, stage.pct);

      halted = await hold(req, stage, () => halted);
      if (halted) break;

      if (stage.then === 'report') {
        const snapshot = await act.snapshotResults(req.experiment);
        await act.sendReport(
          req.owner,
          `Experiment ${req.experiment} at ${pct}%`,
          snapshot,
        );
      }
      if (stage.then === 'analyze') {
        analysis = await act.analyzeResults(req.experiment);
      }
    }
  } finally {
    finished = true;
    await halter.done;
  }

  if (halted) {
    // Runs on a live context, which is the whole reason halt is a signal.
    pct = await act.ensureRampedTo(req.experiment, 0);
    return {status: 'halted', pct, detail: halted};
  }
  return {status: 'launched', pct, detail: 'ramped through every stage'};
}

/**
 * Hold at a stage, watching guardrails while waiting rather than sleeping through
 * the window blind. Returns the reason to stop, or `''` to carry on — so a
 * regression and a halt signal reach the caller by the same route and share one
 * rollback path.
 *
 * The wait is chopped into guardrail-sized pieces, which is also the resolution
 * at which a halt signal is noticed: a timer already started runs to its end, so
 * `guardrailMs` is how long an abort can take to be acted on. The arithmetic is
 * over constants carried in the policy, so it replays identically.
 */
async function hold(
  req: RampRequest,
  stage: RampStage,
  stopped: () => string,
): Promise<string> {
  let waited = 0;
  while (waited < stage.holdMs) {
    if (stopped()) return stopped();
    const step = Math.min(req.guardrailMs, stage.holdMs - waited);
    await sleep(step);
    waited += step;
    if (stopped()) return stopped();
    const metrics = await act.readGuardrails(req.experiment);
    if (metrics.regressed) return `guardrail regressed: ${metrics.reason}`;
  }
  return stopped();
}

/** How a gate closed. Four outcomes, because three of them mean different things downstream. */
type Approval = 'approved' | 'declined' | 'timedOut' | 'halted';

/**
 * Ask a human, and wait — but not forever, and not past an abort.
 *
 * ## Three ways to end a wait, and why all three are needed
 *
 * The stream is scoped to this gate and bounded by whichever comes first: the
 * approval, the timeout, or a halt. Racing the halt in is not a refinement — a
 * gate in production waits *days*, so an abort that only took effect once the
 * gate closed would leave traffic serving through the entire incident it was
 * raised to stop. The bug is invisible at spec timescales and severe at real
 * ones, which is the general hazard with a workflow whose waits are this long.
 *
 * Both bounds are engine promises — a `sleep` and a `condition` — so the race
 * resolves from history and reproduces on replay. A host promise here would make
 * the end point depend on wall-clock timing and diverge.
 *
 * Scoping matters for a second reason: returning from the loop body releases the
 * signal name on the way out, so the next gate can claim its own without tripping
 * the one-consumer-per-signal rule. A bare "wait for the first signal" helper
 * would hold the name for the life of the workflow whenever the timeout won.
 */
async function awaitApproval(
  req: RampRequest,
  stage: RampStage,
  stopped: () => string,
): Promise<Approval> {
  const gate = defineSignal(stage.gate as string);
  await act.requestApproval(
    req.owner,
    `ramp ${req.experiment} to ${stage.pct}%`,
    gate.name,
  );
  for await (const decision of signalStream<{approved: boolean}>(gate, {
    until: Promise.race([
      sleep(req.approvalTimeoutMs),
      condition(() => stopped() !== ''),
    ]),
    // An approver who replied before the request was even sent still counts.
    from: 'start',
  })) {
    return decision.approved ? 'approved' : 'declined';
  }
  return stopped() ? 'halted' : 'timedOut';
}

// ── 3. launch — the spine ──────────────────────────────────────────────────

export interface LaunchRequest {
  cl: string;
  bug: string;
  owner: string;
  policy: RampStage[];
  pollMs: number;
  guardrailMs: number;
  approvalTimeoutMs: number;
}

export interface LaunchResult {
  status: 'launched' | 'halted' | 'abandoned' | 'noFlag' | 'timedOut';
  detail: string;
}

/**
 * The whole pipeline, in the order a person would describe it. Nothing here
 * decides anything — it sequences phases and routes their outcomes — which is
 * exactly the property that lets it stay deployed unchanged for the two weeks a
 * launch takes.
 *
 * Note that landing a CL appears three times: the original, the experiment setup,
 * and the cleanup. It is one workflow used three times with three ids, not three
 * variations, because "get this CL submitted, answering whatever comes up" is the
 * same job every time.
 */
export async function launch(req: LaunchRequest): Promise<LaunchResult> {
  const land = (cl: string): Promise<LandOutcome> =>
    executeChild<LandOutcome>('landCl', {
      workflowId: `land:${cl}`,
      args: [{cl, pollMs: req.pollMs}],
    });

  // Steps 1–3: get the original CL submitted.
  if ((await land(req.cl)) === 'abandoned') {
    await act.notifyOwner(req.owner, `${req.cl} was abandoned`);
    return {status: 'abandoned', detail: req.cl};
  }

  // Step 4: find the flag guarding the new code, and land the CL that sets up
  // the experiment for it. The setup is itself a change, so it is the same job.
  const flag = await act.detectExperimentFlag(req.cl);
  if (!flag) {
    await act.notifyOwner(req.owner, `${req.cl} submitted; no experiment flag`);
    return {status: 'noFlag', detail: req.cl};
  }

  const setupCl = await act.draftExperimentCl(flag, req.policy, req.owner);
  if ((await land(setupCl)) === 'abandoned') {
    await act.notifyOwner(req.owner, `experiment setup ${setupCl} abandoned`);
    return {status: 'abandoned', detail: setupCl};
  }
  const experiment = await act.experimentForFlag(flag);

  // Steps 5–14: the ramp, with its own gates and guardrails.
  const outcome = await executeChild<RampOutcome>('rampExperiment', {
    workflowId: `ramp:${experiment}`,
    args: [
      {
        experiment,
        owner: req.owner,
        policy: req.policy,
        guardrailMs: req.guardrailMs,
        approvalTimeoutMs: req.approvalTimeoutMs,
      },
    ],
  });

  if (outcome.status !== 'launched') {
    await act.notifyOwner(
      req.owner,
      `${experiment} stopped at ${outcome.pct}%: ${outcome.detail}`,
    );
    return {status: outcome.status, detail: outcome.detail};
  }

  // Steps 15–16: the flag has served its purpose, so remove it and close out.
  const cleanupCl = await act.draftCleanupCl(flag, req.owner);
  if ((await land(cleanupCl)) === 'abandoned') {
    await act.notifyOwner(req.owner, `cleanup ${cleanupCl} abandoned`);
    return {status: 'abandoned', detail: cleanupCl};
  }

  await act.notifyOwner(req.owner, `${flag} is fully launched and cleaned up`);
  await act.closeBug(
    req.bug,
    `launched via ${experiment}; cleanup ${cleanupCl}`,
  );
  return {status: 'launched', detail: cleanupCl};
}

export const workflows = {landCl, rampExperiment, launch};
