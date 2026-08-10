/**
 * @fileoverview
 * The reference deployable server, in one file — and the file to copy.
 *
 * Its whole body is one call into the library, which is the point: a consumer
 * building a server artifact under their own build system writes exactly this,
 * with their own defaults in the options object, and bundles it. The counterpart
 * is `examples/greeter.ts`, which is the same file for a worker.
 *
 * Everything about what a server *is* — the flags, the readiness contract, the
 * operational caveats, why the port defaults to 7777 — lives on
 * [`startServer`](../src/server_main.ts), where a reader who has this file in
 * front of them can follow one link and where a consumer who never sees this
 * file still finds it.
 *
 * This is what the specs spawn (`spec/integration/distributed.spec.ts`), so it
 * stays honest: if the entrypoint a consumer copies stops working, the suite
 * fails.
 *
 * ```bash
 * tsx bin/server-main.ts --port=7777 --data-dir=./data
 * ```
 */

import {startServer} from '../src/server_main';

// No options: every value this process needs has a default, and the launch site
// supplies the deviations as flags. A real deployment's server.ts is the same
// call with `{dataDir: …}` filled in, so that durability is a property of the
// artifact rather than of remembering to pass a flag.
//
// Unhandled: a failure to bind or a data directory already locked by a live
// server rejects here and exits non-zero, which is what a supervisor should see.
// A server that swallowed either would be a process that is up and serving
// nothing.
void startServer();
