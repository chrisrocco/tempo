/**
 * @fileoverview
 * Commands are what workflow code produces during a task: a request for the
 * runtime to do something durable (run an activity, start a timer, start a
 * child). The framework stamps each command with a deterministic `seq` in call
 * order; that seq is how the matching completion event is later routed back.
 */

import type { ActivityOptions } from './activity_options';

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
}

/** Cancel a fire-and-forget child, identified by the seq of its startChild command. */
export interface CancelChildCommand extends CommandBase {
  type: 'cancelChild';
  targetSeq: number;
}

/**
 * Terminal command: end the current run and start a fresh one carrying `args`.
 * The core only emits it and halts; the close-and-restart is a server disposition
 * (docs/concepts/continue-as-new.md). Not something the core ever acts on itself.
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
  | Omit<ContinueAsNewCommand, 'seq'>;
