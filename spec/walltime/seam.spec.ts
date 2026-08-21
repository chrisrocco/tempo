/**
 * @fileoverview
 * The `walltime/` library's arm's-length contract, held mechanically.
 *
 * Duration strings and wall-clock rules, treated like a third-party dependency
 * the repo happens to host. The checks — imports nothing, touched only at the
 * call sites named below — are the shared internal-library seam
 * (`spec/support/library_seam.ts`); what is specific to walltime is the removal
 * instruction this surface encodes: delete `src/walltime/`, revert these files
 * to their numbers-only forms, delete the `calendar` member of `ScheduleSpec`,
 * and the engine is whole again.
 */

import {describeLibrarySeam} from '../support/library_seam';

describeLibrarySeam({
  library: 'walltime',
  removalSurface: [
    {path: 'src/core/workflow_api.ts', why: "sleep('30 minutes')"},
    {
      path: 'src/core/activity_options_input.ts',
      why: 'Duration fields on activity options',
    },
    {
      path: 'src/schedule/next_fire.ts',
      why: 'CalendarSpec -> WallClockRule dispatch',
    },
    {
      path: 'src/schedule/schedule_client.ts',
      why: "{every: '1 hour'} interval sugar",
    },
    {path: 'src/schedule/index.ts', why: 're-exports the Duration type'},
    {path: 'src/workflow.ts', why: 're-exports the Duration type'},
  ],
});
