/**
 * @fileoverview
 * The `schema/` library's arm's-length contract, held mechanically.
 *
 * Standard Schema validation, structural JSON Schema with vendor emitters, and
 * strict conformance — treated like a third-party dependency the repo happens
 * to host. The checks are the shared internal-library seam
 * (`spec/support/library_seam.ts`); what is specific to schema is that today
 * its entire removal surface is `connectors/`: the library was extracted from
 * there, and deleting connectors and this library together leaves the engine
 * exactly as it was before either existed. A call site appearing *outside*
 * connectors/ is the moment this library starts paying rent for a second
 * consumer — allowed, deliberately, by naming it here.
 */

import {describeLibrarySeam} from '../../support/library_seam';

describeLibrarySeam({
  library: 'schema',
  removalSurface: [
    {
      path: 'src/connectors/definition.ts',
      why: 'operation inputs/outputs/events are StandardSchemaV1',
    },
    {
      path: 'src/connectors/runtime.ts',
      why: 'connector config validated via runSchema',
    },
    {
      path: 'src/connectors/connector.ts',
      why: 'activity wrappers parse inputs and outputs',
    },
    {
      path: 'src/connectors/catalogue.ts',
      why: 'JSON Schema emission for the dashboard catalogue',
    },
    {
      path: 'src/connectors/live.ts',
      why: 'certification: declared parse, strict conformance, round-trips',
    },
    {
      path: 'src/connectors/index.ts',
      why: 're-exports the schema surface so connector authors have one import root',
    },
  ],
});
