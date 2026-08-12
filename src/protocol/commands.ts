/**
 * @fileoverview
 * Commands are what workflow code produces during a task: a request for the
 * runtime to do something durable (run an activity, start a timer, start a
 * child, signal another execution). The framework stamps each command with a
 * deterministic `seq` in call order; that seq is how the matching completion
 * event is later routed back — and, for the commands that have no completion, how
 * the marker proving the dispatch is keyed.
 *
 * Modeled as a `CommandBase` plus one named interface per variant rather than an
 * inline discriminated union: `CommandBase` documents the shared `seq` once, and
 * naming each variant lets other modules refer to a specific command type
 * directly. It is more verbose than a helper-type encoding, deliberately — there
 * is no conditional-type machinery here to decode.
 */

import type {ActivityOptions} from './activity_options';
import type {ParentClosePolicy} from './parent_close_policy';

/** Fields common to every command. */
export interface CommandBase {
  /** Deterministic id, assigned by the framework in call order. */
  seq: number;
}

export interface ScheduleActivityCommand extends CommandBase {
  type: 'scheduleActivity';
  name: string;
  args: unknown[];
  /** Interpreted only by the server (retries, later timeouts). The core ignores it. */
  options: ActivityOptions;
}

export interface StartTimerCommand extends CommandBase {
  type: 'startTimer';
  ms: number;
}

export interface StartChildCommand extends CommandBase {
  type: 'startChild';
  childName: string;
  childArgs: unknown[];
  /** false = blocking (executeChild); true = fire-and-forget (startChild). */
  detached: boolean;
  /**
   * The child's execution id, when the workflow chose one. Absent means "derive
   * it from lineage" (see `server_core.childExecutionId`).
   *
   * A chosen id is a *claim* on that execution: if one already exists under it,
   * the server correlates to that execution instead of starting a second. This
   * is how a workflow expresses "one child per real-world thing" — one planner
   * per calendar event — rather than one per call.
   */
  workflowId?: string;
  /** Which pool runs the child. Defaults to the parent execution's queue. */
  taskQueue?: string;
  /**
   * What becomes of this child when its parent closes. See
   * `parent_close_policy.ts`.
   *
   * Required, not optional-with-a-server-side-default, because the choice is the
   * *workflow's* and the core is where a workflow's intent is turned into a
   * command. `executeChild` and `startChild` both fill it in, so every command
   * this engine mints carries one and the server never has to guess.
   */
  parentClosePolicy: ParentClosePolicy;
}

/** Cancel a fire-and-forget child, identified by the seq of its startChild command. */
export interface CancelChildCommand extends CommandBase {
  type: 'cancelChild';
  targetSeq: number;
}

/**
 * Send a signal to another execution, addressed by workflow id.
 *
 * The general form rather than a parent-only one, following Temporal's
 * `SignalExternalWorkflowExecution`: the target is an id, and "signal my parent"
 * is that call with `workflowInfo().parent.workflowId` in it. A parent-only
 * primitive would have to be widened later, and widening an API is the change
 * that breaks callers.
 *
 * `targetId` rather than `workflowId` because `applyCommand` already has a
 * `workflowId` in scope — the *sender's* — and one of the two would be read as
 * the other. It also reads as the counterpart of `cancelChild`'s `targetSeq`:
 * addressed by id, not by the seq that spawned it.
 *
 * **Fire-and-forget: no completion event, nothing to await.** See
 * `core/workflow_api.signalWorkflow` for what that costs and why the alternative
 * was declined.
 */
export interface SignalWorkflowCommand extends CommandBase {
  type: 'signalWorkflow';
  /** Which execution to signal. Not required to exist — see `workflowSignaled.delivered`. */
  targetId: string;
  signalName: string;
  payload: unknown;
}

/**
 * Pin a version branch: record that the workflow took the patched side of
 * `patched(patchId)` at this seq.
 *
 * The one command whose entire purpose is its marker. Every other command asks
 * the server to *do* something and leaves a marker as evidence; this one asks for
 * the evidence and nothing else, because the thing being made durable is a
 * decision the workflow already made. `core/workflow_api.patched` owns the
 * reasoning for why the decision has to be durable at all.
 *
 * `patchId` is on the command as well as on the marker so the divergence check
 * has two sides to compare (`core/apply_event`). Without it a patch marker could
 * only be checked for *presence*, and swapping two adjacent patches — which
 * changes which branch each execution takes — would read as agreement.
 */
export interface RecordPatchCommand extends CommandBase {
  type: 'recordPatch';
  /** The author's name for one change. Compared against `patchRecorded.patchId`. */
  patchId: string;
}

/**
 * Terminal command: end the current run and start a fresh one carrying `args`.
 * The core only emits it and halts; the close-and-restart is a server disposition
 * (`server_core.applyWorkflowTaskResult`). Not something the core ever acts on
 * itself.
 */
export interface ContinueAsNewCommand extends CommandBase {
  type: 'continueAsNew';
  args: unknown[];
}

export type Command =
  | ScheduleActivityCommand
  | StartTimerCommand
  | StartChildCommand
  | CancelChildCommand
  | SignalWorkflowCommand
  | RecordPatchCommand
  | ContinueAsNewCommand;

/**
 * A command as produced by workflow code, before the framework assigns `seq`.
 * Written out per-variant on purpose: `Omit<Command, 'seq'>` over a union
 * collapses to only the shared keys, so we omit from each concrete interface.
 */
export type CommandSpec =
  | Omit<ScheduleActivityCommand, 'seq'>
  | Omit<StartTimerCommand, 'seq'>
  | Omit<StartChildCommand, 'seq'>
  | Omit<CancelChildCommand, 'seq'>
  | Omit<SignalWorkflowCommand, 'seq'>
  | Omit<RecordPatchCommand, 'seq'>
  | Omit<ContinueAsNewCommand, 'seq'>;
