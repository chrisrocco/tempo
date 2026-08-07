/**
 * @fileoverview
 * The deployable worker for the launch pipeline, and the one file allowed to see
 * both halves of the determinism boundary.
 *
 * Run it with `tempo up examples/launch/launch.ts`, then start a launch:
 *
 *     tempo start launch '{"cl":"cl/1","bug":"b/1","owner":"you", ...}' --wait
 *
 * ## Why the wiring is here
 *
 * Workflow code may import exactly one module — the author entrypoint — so it
 * cannot import the activity implementations, not even for their types. It
 * therefore *declares* the interface it needs and this file is where the two
 * halves are checked against each other: `createLaunchActivities` returns a
 * `LaunchActivities`, and if an implementation drifts from what the workflows
 * call, this file stops compiling. That is the seam doing its job — the check
 * lands at composition time rather than at two in the morning on a replay.
 *
 * ## Why the policy is data
 *
 * `DEFAULT_POLICY` lives on the host side and is passed to the workflow as an
 * argument. It could have been a constant in the workflow module, and that would
 * have been a mistake: a live execution replays against whatever the workflow
 * module says *now*, so editing the stages would change the behaviour of launches
 * already underway. As an argument it is captured at start, and changing it here
 * affects only launches begun afterwards.
 *
 * The durations are real. A launch started with these takes eleven days to reach
 * full traffic, and costs nothing while it waits.
 */

import {Tempo} from '../../src';
import {createLaunchActivities, createWorld} from './activities';
import {launch, landCl, rampExperiment, type RampStage} from './workflows';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The ramp from the launch plan: 1% → 5% → 10% → 50% → 100%.
 *
 * The two `gate` names differ on purpose. One shared `approval` signal would let
 * a decision meant for the 50% gate be consumed by the 100% gate — the engine
 * cannot tell them apart, because to it they are the same name arriving twice.
 */
export const DEFAULT_POLICY: RampStage[] = [
  {pct: 1, holdMs: DAY},
  {pct: 5, holdMs: DAY},
  // Three days at 10%, then the results snapshot the owner reads before deciding.
  {pct: 10, holdMs: 3 * DAY, then: 'report'},
  // Gated on that decision; three more days, then the analysis pass.
  {pct: 50, holdMs: 3 * DAY, gate: 'approveHalf', then: 'analyze'},
  // Gated on the analysis being clean *and* a human agreeing.
  {pct: 100, holdMs: 0, gate: 'approveFullLaunch'},
];

/**
 * The fake world from `activities.ts`, because this example ships without a
 * review system to talk to. A real deployment builds its activities over real
 * clients here; nothing else in the file changes.
 */
const activities = createLaunchActivities(createWorld());

const workflows = {launch, landCl, rampExperiment};

Tempo.startWorker({
  name: 'launch',
  activities,
  workflows,
});
