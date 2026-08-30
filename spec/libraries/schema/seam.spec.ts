/**
 * @fileoverview
 * The `schema/` library's arm's-length contract, held mechanically.
 *
 * The `t` builder, JSON Schema rendering and strict conformance — treated like
 * a third-party dependency the repo happens to host. The checks are the shared
 * internal-library seam (`spec/support/library_seam.ts`); what is specific to
 * schema is which parts of the engine have come to depend on it. It was
 * `connectors/` alone, where the library was extracted from; workflow props are
 * the second consumer, and the three files below it costs are the whole of it —
 * `workflow_props.ts` renders a declared schema and parses props with it,
 * `createWorkflow` types a declaration from it, and the author entrypoint
 * re-exports `t` so a workflow module can write one without reaching past it.
 * A call site appearing anywhere else is the moment the library starts paying
 * rent for a third consumer — allowed, deliberately, by naming it here.
 *
 * **This no longer means removing it is free.** `workflow-engine/schema` is on
 * the `exports` map, so it is also resolved by name from outside, where this
 * spec cannot look: an empty list here would say the library is unused when it
 * may be load-bearing for a consumer. What it still answers is the narrower
 * question it was built for — how far the *engine* has come to depend on it.
 */

import {describeLibrarySeam} from '../../support/library_seam';

describeLibrarySeam({
  library: 'schema',
  removalSurface: [
    {
      path: 'src/workflow_props.ts',
      why: 'renders a declared props schema, and parses props with it before the body',
    },
    {
      path: 'src/workflow_registry.ts',
      why: 'createWorkflow types a schema-declared workflow from its props schema',
    },
    {
      path: 'src/workflow.ts',
      why: 're-exports `t`, the one runtime import a workflow module is allowed',
    },
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
