# 01 — `proxyActivities<typeof activities>` rejects real activity modules

**Type:** bug (compile failure) · **Blocks:**
[`planning/sprints/01-deployment-api.md`](../sprints/01-deployment-api.md)

## Problem

`proxyActivities<typeof activities>(…)` fails to compile whenever the activity
module exports anything that is not a function — a `const`, an enum, a class, a
re-exported value. Since the deployment API is built on
`import type * as activities from './activities'`, this breaks on the first
realistic activity module.

## Repro

```ts
// acts.ts
export const DEFAULT_TIMEOUT_MS = 5000;
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// wf.ts
import { proxyActivities } from '../src/workflow';
import type * as activities from './acts';

const { greet } = proxyActivities<typeof activities>({});
```

```text
error TS2344: Type 'typeof import(".../acts")' does not satisfy the constraint 'ActivityInterface'.
  Property 'DEFAULT_TIMEOUT_MS' is incompatible with index signature.
    Type 'number' is not assignable to type '(...args: any[]) => any'.
```

Verified against TypeScript 5.7.2, `strict: true`.

## Root cause

[`src/core/workflow_api.ts:104`](../../src/core/workflow_api.ts:104) — the type
parameter is constrained to a record whose values are **all** functions:

```ts
export type ActivityInterface = Record<string, (...args: any[]) => any>;

export function proxyActivities<A extends ActivityInterface>(/* … */);
```

A module namespace object is a heterogeneous record, so it can never satisfy that
constraint. The constraint is also stricter than it needs to be: the proxy only
ever forwards function-valued keys, so non-function exports should be _ignored_,
not rejected.

## Proposed fix

Relax the constraint to `object` and filter function-valued keys in the mapped
type (key remapping, TS 4.1+ — fine on 5.7):

```ts
type AnyFn = (...args: any[]) => any;

export function proxyActivities<A extends object>(
  options: ActivityOptions = {},
): {
  [K in keyof A as A[K] extends AnyFn ? K : never]: A[K] extends AnyFn
    ? (...args: Parameters<A[K]>) => Promise<Awaited<ReturnType<A[K]>>>
    : never;
} {
  /* body unchanged — the runtime proxy already forwards by name */
}
```

Keep `ActivityInterface` exported and unchanged so anyone declaring an explicit
activity interface by hand still can. Only `workflow_api.ts` references it
(`core/index.ts` re-exports it via `export *`; neither `src/index.ts` nor
`workflow.ts` surface it), so this is a low-risk, contained change.

The runtime body needs no edit — the `Proxy` `get` trap already forwards whatever
name it is given.

## Acceptance criteria

- [ ] The repro above compiles.
- [ ] Non-function exports are absent from the proxy's type (destructuring one is
      a compile error, not `any`).
- [ ] Function exports keep full parameter/return inference.
- [ ] `npm run typecheck` clean; `npm test` green.
- [ ] A spec covers a namespace-shaped activity module with a mixed export set.

## Related, not in scope

The same "namespace objects carry non-functions" issue appears at **runtime** when
`Tempo.startWorker({ activities, workflows })` builds its registries from module
namespace objects — it must register only function-valued entries rather than
everything enumerable. That belongs with the `startWorker` implementation, not
here.
