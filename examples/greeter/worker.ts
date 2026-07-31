/**
 * @fileoverview
 * The deployable worker entrypoint — the whole file. `import * as` hands the
 * module namespaces straight over as registries, so the export name is the
 * registered name and there is no registration boilerplate.
 *
 * This file *is* the build target: `tempo deploy` takes the binary built from it.
 * Server URL and role come from the environment, so nothing here is
 * deployment-specific. See docs/guides/build-and-deploy.md.
 */

import { Tempo } from '../../src';
import * as activities from './activities';
import * as workflows from './workflows';

Tempo.startWorker({
  name: 'greeter',
  activities,
  workflows,
});
