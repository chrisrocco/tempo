# Code Style Rules

## Code Formatting 

### Function Definitions

For all statement functions (not inline expressions), use the `function` keyword over arrow functions

```ts{.bad}
export const runActivity = <T = unknown>(name: string, ...args: unknown[]): Promise<T> =>
  scheduleActivity(name, {}, args) as Promise<T>;

export const sleep = (ms: number): Promise<void> =>
  scheduleCommand({ type: 'startTimer', ms }) as Promise<void>;
```

```ts{.good}
export function runActivity<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  return scheduleActivity(name, {}, args) as Promise<T>;
}

export function sleep(ms: number): Promise<void> {
  return scheduleCommand({ type: 'startTimer', ms }) as Promise<void>;
}
```

(One-line inline expressions are exempt — e.g. `export const drainMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));` stays an arrow.)

### @fileoverview comments

Use JS-Doc style multi-line comments with a @fileoverview annotation at the top of the file to explain each module. Prefer this over plain single-line `//` comments. Leave a space after the fileoverview comment.

```ts{.bad}
// The one host-coupled yield in the deterministic core: `drainMicrotasks` lets
// the workflow's own promise chains settle between history events. `setImmediate`
// is a macrotask boundary that reliably flushes the microtask queue; the caveat
// (why this is the acceptable exception to "no host coupling") lives in docs/concepts/replay-and-execution.md.
export const drainMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));
```

```ts{.good}
/**
 * @fileoverview
 * The one host-coupled yield in the deterministic core: `drainMicrotasks` lets
 * the workflow's own promise chains settle between history events. `setImmediate`
 * is a macrotask boundary that reliably flushes the microtask queue; the caveat
 * (why this is the acceptable exception to "no host coupling") lives in docs/concepts/replay-and-execution.md.
 */

export const drainMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));
```

## Testing

Most unit tests should serve as executable documentation. Write the names of the tests as if it were a tutorial demonstrating a single concept or feature. Use a multi-line comment above each test case explaining (tutorial-style) how to use the thing and how it works.

Tests should go in the /spec directory and be structured like you would documentation - with a file per "chapter". Tests should (of course) exhaustively cover all features and functionality. That works because all features and functionality should be explained somewhere in our documentation/tutorial anyways.
