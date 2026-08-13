/**
 * @fileoverview
 * The scheduler's activities, as one module.
 *
 * Narrow on purpose. `proxyActivities` registers **every function-valued export** of
 * whatever it is handed, so this bundle contains only things that are genuinely
 * activities — `isExhausted` next door is a type guard for host code and would have
 * been registered as an activity nobody calls had the workflow imported that module
 * directly.
 *
 * It also exists because a workflow module may value-import only in the shape
 * `import * as NAME`, used for nothing but `proxyActivities`. That rule is what stops
 * `nextFire(...)` being called directly inside replay, where it would read the clock on
 * every attempt and record nothing — so the bundle is what makes the boundary
 * structural rather than a thing to remember.
 */

export {nextFire} from './next_fire_activity';
