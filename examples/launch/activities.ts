/**
 * @fileoverview
 * The other side of the determinism boundary: every call the launch pipeline
 * makes to a code-review system, an experiment service, or a person.
 *
 * These are **fakes over an in-memory world**, not clients. What they are faithful
 * about is the *shape* a real implementation has to have, which is the part that
 * constrains the workflows:
 *
 * - **`ensure`, not `apply`.** Activities are delivered at-least-once, so
 *   `ensureRampedTo` reads what the experiment is actually serving and writes only
 *   on drift. Run it twice and traffic ends up where it was asked to be. A
 *   `rampBy(delta)` in its place would double-apply on a redelivery and there is
 *   nothing the engine could do about it.
 * - **Judgement lives here.** Which findings block a submit, what a comment is
 *   asking for, whether an analysis is clean — all of it, deliberately. Activity
 *   code is not replayed, so it can be redeployed while launches are in flight;
 *   workflow code cannot. Every policy decision moved in here is a decision that
 *   can be changed without draining.
 * - **Ids are derived, not generated.** `experimentForFlag` returns the same id
 *   for the same flag rather than minting a fresh one, so a retry finds the
 *   experiment the previous attempt made instead of creating a second.
 *
 * The world is passed in rather than module-global so a spec can drive the whole
 * pipeline — seeding findings, flipping a guardrail, deciding what an analysis
 * says — without reaching through the engine to do it.
 */

import type {
  AnalysisResult,
  Comment,
  Directive,
  Finding,
  LaunchActivities,
  Metrics,
  RampStage,
  SubmitResult,
} from './workflows';

/** One change under review, as much of it as this pipeline touches. */
export interface ClState {
  findings: Finding[];
  edits: string[];
  replies: string[];
  submitted: boolean;
  abandoned: string | null;
}

/** One launch experiment: the traffic it serves and what the data says about it. */
export interface ExperimentState {
  pct: number;
  guardrails: Metrics;
  analysis: AnalysisResult;
  snapshot: string;
}

/**
 * Everything the fakes read and write. A spec constructs one, hands it to
 * `createLaunchActivities`, and then both drives and inspects the run through it.
 */
export interface World {
  cls: Map<string, ClState>;
  /** Which flag a CL introduced, if any. `detectExperimentFlag` reads this. */
  flags: Map<string, string | null>;
  experiments: Map<string, ExperimentState>;
  /** Everything that would have reached a human, in order. */
  outbox: string[];
  /** Counts calls per activity, so a spec can assert an `ensure` converged rather than thrashed. */
  calls: Map<string, number>;
}

export function createWorld(): World {
  return {
    cls: new Map(),
    flags: new Map(),
    experiments: new Map(),
    outbox: [],
    calls: new Map(),
  };
}

/** Seed a CL into the world. Findings are what must clear before it can submit. */
export function addCl(
  world: World,
  id: string,
  findings: Finding[] = [],
): ClState {
  const cl: ClState = {
    findings: [...findings],
    edits: [],
    replies: [],
    submitted: false,
    abandoned: null,
  };
  world.cls.set(id, cl);
  return cl;
}

function requireCl(world: World, id: string): ClState {
  const cl = world.cls.get(id);
  if (!cl) throw new Error(`no such CL: ${id}`);
  return cl;
}

function count(world: World, name: string): void {
  world.calls.set(name, (world.calls.get(name) ?? 0) + 1);
}

/**
 * Build the activity implementations over a world.
 *
 * The return type is checked against the interface the workflows declare at the
 * point the two are composed — see the worker entrypoint — rather than here, so
 * this module does not have to be the one that knows about workflow code.
 */
export function createLaunchActivities(world: World): LaunchActivities {
  return {
    // ── landing a CL ───────────────────────────────────────────────────────

    async getBlockingFindings(cl: string): Promise<Finding[]> {
      count(world, 'getBlockingFindings');
      return [...requireCl(world, cl).findings];
    },

    /**
     * Where a supervisor agent would actually read the comment. The shape is what
     * matters: it returns a *decision*, and never touches the CL — the workflow
     * has one writer, and this is not it.
     */
    async triageComment(cl: string, comment: Comment): Promise<Directive> {
      count(world, 'triageComment');
      const body = comment.body.toLowerCase();
      if (body.includes('abandon')) {
        return {reply: `Understood, abandoning ${cl}.`, abandon: true};
      }
      if (body.includes('nit') || body.includes('please')) {
        return {
          reply: `Thanks ${comment.author}, addressing that now.`,
          edit: `comment:${comment.id} ${comment.body}`,
        };
      }
      return {reply: `Thanks ${comment.author}.`};
    },

    /**
     * Stands in for a coding agent editing the CL. Applying an edit clears the
     * findings it was meant to fix, which is what makes the reconcile loop
     * converge rather than spin.
     */
    async applyEdits(cl: string, edits: string[]): Promise<void> {
      count(world, 'applyEdits');
      const state = requireCl(world, cl);
      state.edits.push(...edits);
      state.findings = state.findings.filter((f) => f.kind === 'test');
    },

    async postReplies(cl: string, replies: string[]): Promise<void> {
      count(world, 'postReplies');
      requireCl(world, cl).replies.push(...replies);
    },

    async trySubmit(cl: string): Promise<SubmitResult> {
      count(world, 'trySubmit');
      const state = requireCl(world, cl);
      if (state.findings.length > 0) {
        return {submitted: false, blockers: state.findings.map((f) => f.id)};
      }
      state.submitted = true;
      return {submitted: true, blockers: []};
    },

    async abandonCl(cl: string, reason: string): Promise<void> {
      count(world, 'abandonCl');
      requireCl(world, cl).abandoned = reason;
      world.outbox.push(`abandoned ${cl}: ${reason}`);
    },

    // ── the experiment ─────────────────────────────────────────────────────

    async detectExperimentFlag(cl: string): Promise<string | null> {
      count(world, 'detectExperimentFlag');
      return world.flags.get(cl) ?? null;
    },

    async draftExperimentCl(
      flag: string,
      policy: RampStage[],
      owner: string,
    ): Promise<string> {
      count(world, 'draftExperimentCl');
      // Derived from the flag, so a redelivery drafts nothing new.
      const id = `cl/setup-${flag}`;
      if (!world.cls.has(id)) addCl(world, id);
      world.outbox.push(
        `drafted ${id} for ${owner}: ${policy.map((s) => `${s.pct}%`).join(' → ')}`,
      );
      return id;
    },

    async experimentForFlag(flag: string): Promise<string> {
      count(world, 'experimentForFlag');
      const id = `exp:${flag}`;
      if (!world.experiments.has(id)) {
        world.experiments.set(id, {
          pct: 0,
          guardrails: {regressed: false, reason: ''},
          analysis: {clean: true, summary: 'no regression detected'},
          snapshot: 'no data yet',
        });
      }
      return id;
    },

    /**
     * The reconciliation primitive of the ramp: read, compare, write only on
     * drift, return what is now being served. Idempotent by construction, which
     * is what makes at-least-once delivery survivable.
     */
    async ensureRampedTo(experiment: string, pct: number): Promise<number> {
      count(world, 'ensureRampedTo');
      const state = world.experiments.get(experiment);
      if (!state) throw new Error(`no such experiment: ${experiment}`);
      if (state.pct !== pct) {
        world.outbox.push(`${experiment}: ${state.pct}% → ${pct}%`);
        state.pct = pct;
      }
      return state.pct;
    },

    async readGuardrails(experiment: string): Promise<Metrics> {
      count(world, 'readGuardrails');
      return {
        ...(world.experiments.get(experiment)?.guardrails ?? {
          regressed: false,
          reason: '',
        }),
      };
    },

    async snapshotResults(experiment: string): Promise<string> {
      count(world, 'snapshotResults');
      return world.experiments.get(experiment)?.snapshot ?? 'no data';
    },

    async analyzeResults(experiment: string): Promise<AnalysisResult> {
      count(world, 'analyzeResults');
      return {
        ...(world.experiments.get(experiment)?.analysis ?? {
          clean: true,
          summary: 'no data',
        }),
      };
    },

    // ── the humans ─────────────────────────────────────────────────────────

    async sendReport(
      owner: string,
      subject: string,
      body: string,
    ): Promise<void> {
      count(world, 'sendReport');
      world.outbox.push(`report to ${owner}: ${subject} — ${body}`);
    },

    async requestApproval(
      owner: string,
      topic: string,
      signalName: string,
    ): Promise<void> {
      count(world, 'requestApproval');
      // A real one would render a link that signals the execution. The signal
      // name is in the message because that is what the approver's click needs.
      world.outbox.push(`approval from ${owner} for ${topic} [${signalName}]`);
    },

    async notifyOwner(owner: string, message: string): Promise<void> {
      count(world, 'notifyOwner');
      world.outbox.push(`notify ${owner}: ${message}`);
    },

    async closeBug(bug: string, resolution: string): Promise<void> {
      count(world, 'closeBug');
      world.outbox.push(`closed ${bug}: ${resolution}`);
    },

    // ── cleanup ────────────────────────────────────────────────────────────

    async draftCleanupCl(flag: string, owner: string): Promise<string> {
      count(world, 'draftCleanupCl');
      const id = `cl/cleanup-${flag}`;
      if (!world.cls.has(id)) addCl(world, id);
      world.outbox.push(`drafted ${id} for ${owner}: remove ${flag}`);
      return id;
    },
  };
}
