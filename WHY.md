# Why you might need this

A narrative, not a feature list. It starts with a small automation any developer
might write this afternoon, adds one reasonable requirement at a time, and shows
you the **whole program at every stage** — not a sketch of the change, the
actual file as it now stands — so you can watch a page of business logic turn
into a system. Then the same automation is written against this engine, and the
ladder collapses back into a page.

## The idea

When a new bug lands on the team's hotlist, have a coding agent attempt a fix
and open a PR. Wait for CI. Ask a human to review. If they approve, merge; if CI
fails or nobody answers, escalate to the team channel.

That is the whole spec. Five verbs and two decisions.

One file talks to the outside world, and it is deliberately boring. It stays
almost untouched through everything that follows — the growth is all
orchestration:

```ts
// services.ts — the outside world. ~20 lines, and not the interesting part.
export interface Bug {
  id: string;
  title: string;
}

export async function fetchHotlist(hotlist: string): Promise<Bug[]> { /* GET /hotlists/:id */ }
export async function runFixAgent(bug: Bug): Promise<{prUrl: string}> { /* run the agent, open a PR */ }
export async function ciStatus(prUrl: string): Promise<'pending' | 'green' | 'red'> { /* GET the checks */ }
export async function reviewVerdict(prUrl: string): Promise<'pending' | 'approved' | 'declined'> { /* GET the review */ }
export async function requestReview(prUrl: string): Promise<void> { /* assign a reviewer */ }
export async function merge(prUrl: string): Promise<void> { /* squash-merge */ }
export async function escalate(bug: Bug, why: string): Promise<void> { /* post to the team channel */ }
```

## v0 — the program you want to write

A tick function: check the state of the world, do what's new. Run it on an
interval.

```ts
// autofix.ts — v0
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  merge,
  requestReview,
  reviewVerdict,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seen = new Set<string>();

async function handle(bug: Bug): Promise<void> {
  const {prUrl} = await runFixAgent(bug);

  let ci = await ciStatus(prUrl);
  while (ci === 'pending') {
    await sleepMs(60_000);
    ci = await ciStatus(prUrl);
  }
  if (ci === 'red') return escalate(bug, 'CI failed');

  await requestReview(prUrl);
  let verdict = await reviewVerdict(prUrl);
  while (verdict === 'pending') {
    await sleepMs(10 * 60_000);
    verdict = await reviewVerdict(prUrl);
  }

  if (verdict === 'approved') return merge(prUrl);
  return escalate(bug, 'review declined');
}

async function tick(): Promise<void> {
  for (const bug of await fetchHotlist('my-team')) {
    if (seen.has(bug.id)) continue;
    seen.add(bug.id);
    await handle(bug);
  }
}

setInterval(tick, 5 * 60_000);
```

**38 lines**, and it reads like the spec. Each `await` is a step; the control
flow _is_ the business logic. This is the program you want to have written.

It is also a program that only works on a machine that never restarts, calling
services that never fail, doing work that never overlaps, for a team that never
asks what it's doing. Let's fix that, one reasonable request at a time.

## v1 — but you probably want it to survive a restart

`seen` lives in memory. Deploy, crash, or reboot, and the process comes back
knowing nothing — and re-runs the agent on every bug on the hotlist, opening a
second PR for each. So the set becomes a table. And once it's a table, "handled"
turns out never to have been a boolean: record a bug _before_ the work and a
crash mid-fix marks it handled-but-unfixed forever; record it _after_ and the
crash re-fixes it. There is no safe place for a single write, so it becomes a
_status_, updated between every step.

```sql
-- schema.sql
CREATE TABLE fixes (
  bug_id TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- fixing | awaiting-ci | awaiting-review | merged | escalated
  pr_url TEXT
);
```

```ts
// autofix.ts — v1
import {db} from './db'; // one sqlite connection: db.run / db.get / db.all
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  merge,
  requestReview,
  reviewVerdict,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setStatus(bugId: string, status: string): Promise<void> {
  await db.run(`UPDATE fixes SET status = ? WHERE bug_id = ?`, status, bugId);
}

async function handle(bug: Bug): Promise<void> {
  await db.run(
    `INSERT INTO fixes (bug_id, status) VALUES (?, 'fixing')`,
    bug.id,
  );

  const {prUrl} = await runFixAgent(bug);
  // pr_url is a column now: any state a later step needs has to be persisted,
  // because after a restart the row is all there is.
  await db.run(
    `UPDATE fixes SET status = 'awaiting-ci', pr_url = ? WHERE bug_id = ?`,
    prUrl,
    bug.id,
  );

  let ci = await ciStatus(prUrl);
  while (ci === 'pending') {
    await sleepMs(60_000);
    ci = await ciStatus(prUrl);
  }
  if (ci === 'red') {
    await escalate(bug, 'CI failed');
    return setStatus(bug.id, 'escalated');
  }

  await requestReview(prUrl);
  await setStatus(bug.id, 'awaiting-review');

  let verdict = await reviewVerdict(prUrl);
  while (verdict === 'pending') {
    await sleepMs(10 * 60_000);
    verdict = await reviewVerdict(prUrl);
  }

  if (verdict === 'approved') {
    await merge(prUrl);
    return setStatus(bug.id, 'merged');
  }
  await escalate(bug, 'review declined');
  return setStatus(bug.id, 'escalated');
}

async function tick(): Promise<void> {
  for (const bug of await fetchHotlist('my-team')) {
    if (await db.get(`SELECT 1 FROM fixes WHERE bug_id = ?`, bug.id)) continue;
    await handle(bug);
  }
}

setInterval(tick, 5 * 60_000);
```

**~60 lines, plus a schema.** And a hole we can already see but not yet afford
to fix: after a restart, rows sit in `fixing` or `awaiting-ci` and _nothing ever
touches them again_ — the dedupe check skips them, and the straight-line
function that was mid-flight through them is gone. Hold that thought; it costs
us the whole shape of the program in v4.

## v2 — but you probably want each bug fixed exactly once

The agent takes forty minutes; the interval is five. Ticks overlap, and two
overlapping ticks both find the same un-handled bug before either records it —
two agents, two PRs. So the check becomes a _claim_ (an insert that can lose),
and the tick becomes single-flight.

```ts
// autofix.ts — v2
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  merge,
  requestReview,
  reviewVerdict,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ticking = false; // the agent takes 40 minutes; the interval is 5

async function setStatus(bugId: string, status: string): Promise<void> {
  await db.run(`UPDATE fixes SET status = ? WHERE bug_id = ?`, status, bugId);
}

async function handle(bug: Bug): Promise<void> {
  const {prUrl} = await runFixAgent(bug);
  await db.run(
    `UPDATE fixes SET status = 'awaiting-ci', pr_url = ? WHERE bug_id = ?`,
    prUrl,
    bug.id,
  );

  let ci = await ciStatus(prUrl);
  while (ci === 'pending') {
    await sleepMs(60_000);
    ci = await ciStatus(prUrl);
  }
  if (ci === 'red') {
    await escalate(bug, 'CI failed');
    return setStatus(bug.id, 'escalated');
  }

  await requestReview(prUrl);
  await setStatus(bug.id, 'awaiting-review');

  let verdict = await reviewVerdict(prUrl);
  while (verdict === 'pending') {
    await sleepMs(10 * 60_000);
    verdict = await reviewVerdict(prUrl);
  }

  if (verdict === 'approved') {
    await merge(prUrl);
    return setStatus(bug.id, 'merged');
  }
  await escalate(bug, 'review declined');
  return setStatus(bug.id, 'escalated');
}

async function tick(): Promise<void> {
  if (ticking) return; // single flight: overlapping ticks both saw "no row" in v1
  ticking = true;
  try {
    for (const bug of await fetchHotlist('my-team')) {
      // A claim, not a check: INSERT OR IGNORE means exactly one tick wins the
      // race, and the loser finds out via changes === 0 instead of a crash.
      const claim = await db.run(
        `INSERT OR IGNORE INTO fixes (bug_id, status) VALUES (?, 'fixing')`,
        bug.id,
      );
      if (claim.changes === 0) continue;
      await handle(bug);
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 5 * 60_000);
```

**~65 lines, and a uniqueness invariant you must never migrate away.** Note
what the claim also did: the crashed rows from v1 are now _permanently_ stuck —
claimed, so never re-claimed; abandoned, so never resumed. "Exactly once" is
half-built: we've stopped the work from starting twice, but nothing can yet
_finish_ what started once. That bill comes due in v4.

## v3 — but you probably want retries

The tracker API rate-limits. The agent flakes. CI's status endpoint 500s at 2am.
One thrown error currently kills the whole tick — including the loop over every
_other_ bug. So: a retry helper with backoff, a decision about which errors are
worth retrying, a cap on attempts — and the attempt count has to be _persisted_,
or a crash-looping process resets the budget every boot and retries forever.

```sql
-- schema.sql
CREATE TABLE fixes (
  bug_id TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- fixing | awaiting-ci | awaiting-review | merged | escalated | failed
  pr_url TEXT,
  error  TEXT
);
CREATE TABLE attempts (
  key   TEXT PRIMARY KEY, -- e.g. 'agent:BUG-4712'
  count INTEGER NOT NULL
);
```

```ts
// autofix.ts — v3
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  merge,
  requestReview,
  reviewVerdict,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
let ticking = false;

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  // A guess, to be refined in production, one incident at a time.
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // The attempt count lives in the db: an in-memory counter resets when a
  // crash-looping process restarts, and then "5 attempts" means forever.
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      // Backoff — and the whole process is pinned here while it waits.
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

async function setStatus(bugId: string, status: string): Promise<void> {
  await db.run(`UPDATE fixes SET status = ? WHERE bug_id = ?`, status, bugId);
}

async function handle(bug: Bug): Promise<void> {
  const {prUrl} = await withRetry(`agent:${bug.id}`, () => runFixAgent(bug));
  await db.run(
    `UPDATE fixes SET status = 'awaiting-ci', pr_url = ? WHERE bug_id = ?`,
    prUrl,
    bug.id,
  );

  let ci = await withRetry(`ci:${bug.id}`, () => ciStatus(prUrl));
  while (ci === 'pending') {
    await sleepMs(60_000);
    ci = await withRetry(`ci:${bug.id}`, () => ciStatus(prUrl));
  }
  if (ci === 'red') {
    await escalate(bug, 'CI failed');
    return setStatus(bug.id, 'escalated');
  }

  await withRetry(`review:${bug.id}`, () => requestReview(prUrl));
  await setStatus(bug.id, 'awaiting-review');

  let verdict = await withRetry(`verdict:${bug.id}`, () => reviewVerdict(prUrl));
  while (verdict === 'pending') {
    await sleepMs(10 * 60_000);
    verdict = await withRetry(`verdict:${bug.id}`, () => reviewVerdict(prUrl));
  }

  if (verdict === 'approved') {
    await withRetry(`merge:${bug.id}`, () => merge(prUrl));
    return setStatus(bug.id, 'merged');
  }
  await escalate(bug, 'review declined');
  return setStatus(bug.id, 'escalated');
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const bugs = await withRetry('hotlist', () => fetchHotlist('my-team'));
    for (const bug of bugs) {
      const claim = await db.run(
        `INSERT OR IGNORE INTO fixes (bug_id, status) VALUES (?, 'fixing')`,
        bug.id,
      );
      if (claim.changes === 0) continue;
      try {
        await handle(bug);
      } catch (err) {
        // One bug's bad day must not starve the rest of the hotlist.
        await db.run(
          `UPDATE fixes SET status = 'failed', error = ? WHERE bug_id = ?`,
          String(err),
          bug.id,
        );
      }
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 5 * 60_000);
```

**~105 lines.** The business logic is still in there, wrapped once per call
site. Squint past the plumbing and you can still read the spec — barely.

## v4 — but you probably want to wait longer than a process lives

CI takes twenty minutes. Review takes days. Everything above waits by keeping an
`await` open — which means keeping the _process_ open, which means a deploy or a
crash abandons every wait in flight. Nobody notices, because a lost `await`
makes no sound: bug 4712 just never merges. And v2's stuck rows are still
stuck, because resuming from the middle of a straight-line function is not a
thing a process can do.

This is the requirement that kills the straight-line function. You cannot hold
program state across a process boundary, so the waits invert: the code must
_end_, and a later tick must figure out where to resume from the row alone. The
program becomes a dispatcher over the status column — and "exactly once"
finally comes due in full: any step can now re-run after a crash, so every step
must tolerate having already happened. (`findOpenPr` is new in `services.ts`:
idempotency just leaked into the file we swore was finished.)

```sql
-- schema.sql
CREATE TABLE fixes (
  bug_id TEXT PRIMARY KEY,
  title  TEXT NOT NULL, -- even the bug's title is a column now: the row is all
                        -- a later tick has
  status TEXT NOT NULL, -- queued | awaiting-ci | awaiting-review
                        -- | merged | escalated | failed
  pr_url TEXT,
  error  TEXT
);
CREATE TABLE attempts (
  key   TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
```

```ts
// autofix.ts — v4: nothing may wait in memory, so the straight line inverts
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr, // new in services.ts — "is there already a PR for bug X?"
  merge,
  requestReview,
  reviewVerdict,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
let ticking = false;

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  pr_url: string | null;
  error: string | null;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?${cols.map((c) => `, ${c} = ?`).join('')}
      WHERE bug_id = ?`,
    status,
    ...Object.values(extra),
    fix.bug_id,
  );
}

// One step per tick, per fix. Waiting = staying in the same status across
// ticks. The spec — "first the fix, then CI, then review, then the decision" —
// is no longer written anywhere; it is implied by which statuses lead to which.
async function step(fix: FixRow): Promise<void> {
  switch (fix.status) {
    case 'queued': {
      // Resume-safety: a crashed run may have opened the PR and died before
      // recording it. Ask the world before doing anything unsafe to repeat.
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (await withRetry(`agent:${fix.bug_id}`, () => runFixAgent(bugOf(fix))))
          .prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return; // stay; a later tick will look again
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      const verdict = await withRetry(`verdict:${fix.bug_id}`, () =>
        reviewVerdict(fix.pr_url!),
      );
      if (verdict === 'pending') return;
      if (verdict === 'approved') {
        await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
        return transition(fix, 'merged');
      }
      await escalate(bugOf(fix), 'review declined');
      return transition(fix, 'escalated');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status)
         VALUES (?, ?, 'queued')`,
      bug.id,
      bug.title,
    );
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await claimNewBugs();
    const open = await db.all<FixRow>(
      `SELECT * FROM fixes
        WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')`,
    );
    for (const fix of open) {
      try {
        await step(fix);
      } catch (err) {
        await transition(fix, 'failed', {error: String(err)});
      }
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 5 * 60_000);
```

**~140 lines.** Notice what happened: the program you wanted to write — first
this, then that, then if-approved-merge — no longer exists anywhere in the
source. It is smeared across status values and case arms, and every future
change means updating a diagram that lives only in your head. This shape has a
name: you have hand-rolled a state machine, and the state machine _is_ the
control flow you used to get for free from `async/await`. Also quietly lost:
the one-minute CI poll — everything is now quantized to the tick.

## v5 — but you probably want the human's answer delivered, not polled for

Polling `reviewVerdict` every five minutes for three days is thousands of API
calls to learn one bit. The reviewer's click should _arrive_. So: a webhook
endpoint — which needs a route, a port, a correlation id (the bug id has to
round-trip through the review tool, so the agent must stamp it into the PR
description: another quiet contract), and an answer for two races. The approval
that arrives _before_ the fix reaches `awaiting-review`, and the one that
arrives _while_ a tick is mid-step on the same row. We survive both by making
the webhook do nothing but append to a table — the insert-only buffer is also
the lock we get to not take. Anything richer and we'd be locking rows across
two request paths.

```sql
-- schema.sql (new table; fixes and attempts unchanged from v4)
CREATE TABLE review_events (
  bug_id   TEXT NOT NULL,
  approved INTEGER NOT NULL
);
```

```ts
// autofix.ts — v5: one polling loop dies, an HTTP server is born
import express from 'express'; // the program has dependencies and a port now
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent, // reviewVerdict is gone — reviews arrive, they are not fetched
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
let ticking = false;

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  pr_url: string | null;
  error: string | null;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?${cols.map((c) => `, ${c} = ?`).join('')}
      WHERE bug_id = ?`,
    status,
    ...Object.values(extra),
    fix.bug_id,
  );
}

async function step(fix: FixRow): Promise<void> {
  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (await withRetry(`agent:${fix.bug_id}`, () => runFixAgent(bugOf(fix))))
          .prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      // Consume what the webhook buffered — whether it arrived early or late.
      const event = await db.get<{approved: number}>(
        `SELECT approved FROM review_events WHERE bug_id = ? LIMIT 1`,
        fix.bug_id,
      );
      if (!event) return; // nobody has answered yet
      if (event.approved) {
        await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
        return transition(fix, 'merged');
      }
      await escalate(bugOf(fix), 'review declined');
      return transition(fix, 'escalated');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status)
         VALUES (?, ?, 'queued')`,
      bug.id,
      bug.title,
    );
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await claimNewBugs();
    const open = await db.all<FixRow>(
      `SELECT * FROM fixes
        WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')`,
    );
    for (const fix of open) {
      try {
        await step(fix);
      } catch (err) {
        await transition(fix, 'failed', {error: String(err)});
      }
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// The reviewer's click lands here — possibly before the fix reaches
// awaiting-review, possibly while a tick is mid-step on this very row. The
// insert-only table is both the buffer and the lock we avoid taking.
app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.listen(8080);
```

**~165 lines, two tables, one HTTP server.**

## v6 — but you probably want deadlines, and to tell slow from dead

The reviewer is on vacation. CI's webhook was dropped. The agent hangs. A fix
that waits forever is indistinguishable from one making progress — so every
wait needs a deadline, and deadlines that survive restarts can't be
`setTimeout`: they're arithmetic on a persisted timestamp, so `status_since`
becomes a column and `transition` stamps it.

The hung agent is worse, because a flat timeout kills the legitimate three-hour
run and no timeout leaks the hung one forever. Slow and dead look identical
from outside; the only fix is for the agent to report progress, and for
_silence_ to be what times out. So `runFixAgent` grows an `onProgress` callback
— the second time this requirement has leaked into `services.ts`.

```sql
-- schema.sql (fixes gains status_since; attempts, review_events unchanged)
CREATE TABLE fixes (
  bug_id       TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,
  pr_url       TEXT,
  error        TEXT,
  status_since INTEGER NOT NULL
);
```

```ts
// autofix.ts — v6: silence is now a failure mode with a budget
import express from 'express';
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent, // signature changed: runFixAgent(bug, {onProgress})
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const AGENT_STALL_MS = 5 * 60_000; // no heartbeat for 5m = dead, not slow
const CI_DEADLINE_MS = 2 * 60 * 60_000;
const REVIEW_DEADLINE_MS = 3 * 24 * 60 * 60_000;
let ticking = false;

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  pr_url: string | null;
  error: string | null;
  status_since: number;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

function withStallTimeout<T>(
  stallMs: number,
  run: (beat: () => void) => Promise<T>,
): Promise<T> {
  // The stalled attempt is still running — nothing here can stop it. We only
  // stop *waiting* for it, and hope the retry doesn't race the zombie.
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no heartbeat for ${stallMs}ms`)),
        stallMs,
      );
    };
    arm();
    run(arm).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?, status_since = ?${cols
      .map((c) => `, ${c} = ?`)
      .join('')}
      WHERE bug_id = ?`,
    status,
    Date.now(),
    ...Object.values(extra),
    fix.bug_id,
  );
}

async function step(fix: FixRow): Promise<void> {
  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (
          await withRetry(`agent:${fix.bug_id}`, () =>
            withStallTimeout(AGENT_STALL_MS, (beat) =>
              runFixAgent(bugOf(fix), {onProgress: beat}),
            ),
          )
        ).prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      if (Date.now() - fix.status_since > CI_DEADLINE_MS) {
        await escalate(bugOf(fix), `CI silent for 2h on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      if (Date.now() - fix.status_since > REVIEW_DEADLINE_MS) {
        await escalate(bugOf(fix), 'no review in 3 days');
        return transition(fix, 'escalated');
      }
      const event = await db.get<{approved: number}>(
        `SELECT approved FROM review_events WHERE bug_id = ? LIMIT 1`,
        fix.bug_id,
      );
      if (!event) return;
      if (event.approved) {
        await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
        return transition(fix, 'merged');
      }
      await escalate(bugOf(fix), 'review declined');
      return transition(fix, 'escalated');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status, status_since)
         VALUES (?, ?, 'queued', ?)`,
      bug.id,
      bug.title,
      Date.now(),
    );
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await claimNewBugs();
    const open = await db.all<FixRow>(
      `SELECT * FROM fixes
        WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')`,
    );
    for (const fix of open) {
      try {
        await step(fix);
      } catch (err) {
        await transition(fix, 'failed', {error: String(err)});
      }
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.listen(8080);
```

**~210 lines.** `Date.now()` is now load-bearing in four places — remember that
when we get to testing.

## v7 — but you probably want to cancel one

A bug gets closed as working-as-intended while the fix is mid-flight. "Just
stop it" means: a flag every case arm must check, an endpoint to set it, and a
race you cannot fully close — a cancel that lands while the merge call is in
flight still merges. Cancellation isn't a feature; it's a tax on every arm
you've written and every one you'll write next.

Changes from v6: a `cancel_requested` column, a `cancelled` terminal status, a
check at the top of `step`, a re-read right before the merge, and a new
endpoint. Everything else stands, so — for the last time before the listings
get long — here is the whole file:

```sql
-- schema.sql (fixes gains cancel_requested)
CREATE TABLE fixes (
  bug_id           TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  pr_url           TEXT,
  error            TEXT,
  status_since     INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
```

```ts
// autofix.ts — v7: stopping is harder than starting
import express from 'express';
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const AGENT_STALL_MS = 5 * 60_000;
const CI_DEADLINE_MS = 2 * 60 * 60_000;
const REVIEW_DEADLINE_MS = 3 * 24 * 60 * 60_000;
let ticking = false;

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  pr_url: string | null;
  error: string | null;
  status_since: number;
  cancel_requested: number;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

function withStallTimeout<T>(
  stallMs: number,
  run: (beat: () => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no heartbeat for ${stallMs}ms`)),
        stallMs,
      );
    };
    arm();
    run(arm).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?, status_since = ?${cols
      .map((c) => `, ${c} = ?`)
      .join('')}
      WHERE bug_id = ?`,
    status,
    Date.now(),
    ...Object.values(extra),
    fix.bug_id,
  );
}

async function step(fix: FixRow): Promise<void> {
  // The cancel tax, paid at the door — but a step already past the door (an
  // agent forty minutes into a run, in this process or another) finishes and
  // lands its transition anyway.
  if (fix.cancel_requested) return transition(fix, 'cancelled');

  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (
          await withRetry(`agent:${fix.bug_id}`, () =>
            withStallTimeout(AGENT_STALL_MS, (beat) =>
              runFixAgent(bugOf(fix), {onProgress: beat}),
            ),
          )
        ).prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      if (Date.now() - fix.status_since > CI_DEADLINE_MS) {
        await escalate(bugOf(fix), `CI silent for 2h on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      if (Date.now() - fix.status_since > REVIEW_DEADLINE_MS) {
        await escalate(bugOf(fix), 'no review in 3 days');
        return transition(fix, 'escalated');
      }
      const event = await db.get<{approved: number}>(
        `SELECT approved FROM review_events WHERE bug_id = ? LIMIT 1`,
        fix.bug_id,
      );
      if (!event) return;
      if (event.approved) {
        // Re-check at the last responsible moment. A cancel that lands after
        // this read but before the merge returns still merges: the window is
        // smaller now, not closed.
        const fresh = await db.get<{cancel_requested: number}>(
          `SELECT cancel_requested FROM fixes WHERE bug_id = ?`,
          fix.bug_id,
        );
        if (fresh!.cancel_requested) return transition(fix, 'cancelled');
        await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
        return transition(fix, 'merged');
      }
      await escalate(bugOf(fix), 'review declined');
      return transition(fix, 'escalated');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status, status_since)
         VALUES (?, ?, 'queued', ?)`,
      bug.id,
      bug.title,
      Date.now(),
    );
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await claimNewBugs();
    const open = await db.all<FixRow>(
      `SELECT * FROM fixes
        WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')`,
    );
    for (const fix of open) {
      try {
        await step(fix);
      } catch (err) {
        await transition(fix, 'failed', {error: String(err)});
      }
    }
  } finally {
    ticking = false;
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.post('/fixes/:bugId/cancel', async (req, res) => {
  await db.run(
    `UPDATE fixes SET cancel_requested = 1 WHERE bug_id = ?`,
    req.params.bugId,
  );
  res.sendStatus(202); // requested, not done — see step()
});

app.listen(8080);
```

**~240 lines.**

## v8 — but you probably want more than one machine

For throughput, or just so a deploy isn't an outage. The moment there are two
processes, the `ticking` boolean is a joke — it lives in one of them. Mutual
exclusion has to move into the database: rows are _leased_, a worker claims one
step at a time with an atomic update, and a lease that expires means its worker
is presumed dead and the row is up for grabs. Which reopens every question we
thought was settled: the lease duration is a guess (too short: two workers run
the same step; too long: a dead worker's row sits idle for minutes), the
forty-minute agent outlives any sane lease (so the heartbeat now does double
duty, renewing the lease), and "presumed dead" is exactly the slow-vs-dead
problem from v6, now at the process level.

```sql
-- schema.sql (fixes gains leased_by, lease_until)
CREATE TABLE fixes (
  bug_id           TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  pr_url           TEXT,
  error            TEXT,
  status_since     INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  leased_by        TEXT,
  lease_until      INTEGER
);
```

```ts
// autofix.ts — v8: congratulations, it's a distributed system
import express from 'express';
import * as os from 'node:os';
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const AGENT_STALL_MS = 5 * 60_000;
const CI_DEADLINE_MS = 2 * 60 * 60_000;
const REVIEW_DEADLINE_MS = 3 * 24 * 60 * 60_000;
const LEASE_MS = 2 * 60_000; // a guess, tuned by incident
const WORKER = `${os.hostname()}#${process.pid}`;

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  pr_url: string | null;
  error: string | null;
  status_since: number;
  cancel_requested: number;
  leased_by: string | null;
  lease_until: number | null;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

function withStallTimeout<T>(
  stallMs: number,
  run: (beat: () => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no heartbeat for ${stallMs}ms`)),
        stallMs,
      );
    };
    arm();
    run(arm).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?, status_since = ?${cols
      .map((c) => `, ${c} = ?`)
      .join('')}
      WHERE bug_id = ?`,
    status,
    Date.now(),
    ...Object.values(extra),
    fix.bug_id,
  );
}

async function step(fix: FixRow): Promise<void> {
  if (fix.cancel_requested) return transition(fix, 'cancelled');

  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (
          await withRetry(`agent:${fix.bug_id}`, () =>
            withStallTimeout(AGENT_STALL_MS, (beat) =>
              runFixAgent(bugOf(fix), {
                onProgress: () => {
                  beat();
                  // The agent outlives any sane lease; progress renews it.
                  void db.run(
                    `UPDATE fixes SET lease_until = ? WHERE bug_id = ?`,
                    Date.now() + LEASE_MS,
                    fix.bug_id,
                  );
                },
              }),
            ),
          )
        ).prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      if (Date.now() - fix.status_since > CI_DEADLINE_MS) {
        await escalate(bugOf(fix), `CI silent for 2h on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      if (Date.now() - fix.status_since > REVIEW_DEADLINE_MS) {
        await escalate(bugOf(fix), 'no review in 3 days');
        return transition(fix, 'escalated');
      }
      const event = await db.get<{approved: number}>(
        `SELECT approved FROM review_events WHERE bug_id = ? LIMIT 1`,
        fix.bug_id,
      );
      if (!event) return;
      if (event.approved) {
        const fresh = await db.get<{cancel_requested: number}>(
          `SELECT cancel_requested FROM fixes WHERE bug_id = ?`,
          fix.bug_id,
        );
        if (fresh!.cancel_requested) return transition(fix, 'cancelled');
        await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
        return transition(fix, 'merged');
      }
      await escalate(bugOf(fix), 'review declined');
      return transition(fix, 'escalated');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  // Every worker polls the hotlist; INSERT OR IGNORE makes the race harmless.
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status, status_since)
         VALUES (?, ?, 'queued', ?)`,
      bug.id,
      bug.title,
      Date.now(),
    );
  }
}

async function claimStep(): Promise<FixRow | undefined> {
  // Atomic claim: one open, unleased (or lease-expired) row. An expired lease
  // means a presumed-dead worker — if it was merely slow, two workers now run
  // the same step, which is why every step had to tolerate re-execution.
  return db.get<FixRow>(
    `UPDATE fixes SET leased_by = ?, lease_until = ?
      WHERE bug_id = (
        SELECT bug_id FROM fixes
         WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')
           AND (lease_until IS NULL OR lease_until < ?)
         LIMIT 1)
      RETURNING *`,
    WORKER,
    Date.now() + LEASE_MS,
    Date.now(),
  );
}

async function tick(): Promise<void> {
  await claimNewBugs();
  for (;;) {
    const fix = await claimStep();
    if (!fix) return;
    try {
      await step(fix);
    } catch (err) {
      await transition(fix, 'failed', {error: String(err)});
    } finally {
      await db.run(
        `UPDATE fixes SET leased_by = NULL, lease_until = NULL
          WHERE bug_id = ? AND leased_by = ?`,
        fix.bug_id,
        WORKER,
      );
    }
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.post('/fixes/:bugId/cancel', async (req, res) => {
  await db.run(
    `UPDATE fixes SET cancel_requested = 1 WHERE bug_id = ?`,
    req.params.bugId,
  );
  res.sendStatus(202);
});

app.listen(8080);
```

**~280 lines, and the correctness argument lives in three comments.** Sqlite
won't survive multiple machines either, so mentally add "migrate to Postgres"
to the backlog — another change this document gets to wave at and your team
does not.

## v9 — but you probably want to see what it's doing

The first question anyone asks: "why hasn't 4712 merged?" The status column
says `awaiting-review` — since when? after how many retries? on which worker?
waiting on whom? So every transition starts writing an audit row, and an
endpoint reassembles a fix's story on demand. You are, one afternoon in,
building a `describe()` — because operating the system without one turned out
to be impossible.

The change is additive — a table, a second write in `transition`, two
functions at the bottom. But here is the whole program again, because that is
now the deal: every "small" addition rides on top of everything before it, and
the whole stack is what the next person reads.

```sql
-- schema.sql
CREATE TABLE fixes (
  bug_id           TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  pr_url           TEXT,
  error            TEXT,
  status_since     INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  leased_by        TEXT,
  lease_until      INTEGER
);
CREATE TABLE attempts (
  key   TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
CREATE TABLE review_events (
  bug_id   TEXT NOT NULL,
  approved INTEGER NOT NULL
);
CREATE TABLE transitions (
  bug_id      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  worker      TEXT NOT NULL,
  detail      TEXT
);
```

```ts
// autofix.ts — v9: the audit trail nobody scoped and everybody needs
import express from 'express';
import * as os from 'node:os';
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const AGENT_STALL_MS = 5 * 60_000;
const CI_DEADLINE_MS = 2 * 60 * 60_000;
const REVIEW_DEADLINE_MS = 3 * 24 * 60 * 60_000;
const LEASE_MS = 2 * 60_000;
const WORKER = `${os.hostname()}#${process.pid}`;

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  pr_url: string | null;
  error: string | null;
  status_since: number;
  cancel_requested: number;
  leased_by: string | null;
  lease_until: number | null;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

function withStallTimeout<T>(
  stallMs: number,
  run: (beat: () => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no heartbeat for ${stallMs}ms`)),
        stallMs,
      );
    };
    arm();
    run(arm).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?, status_since = ?${cols
      .map((c) => `, ${c} = ?`)
      .join('')}
      WHERE bug_id = ?`,
    status,
    Date.now(),
    ...Object.values(extra),
    fix.bug_id,
  );
  // The trail. Two writes, not one transaction — a crash between them leaves
  // a transition that history doesn't know about, which the dashboard will
  // faithfully not show.
  await db.run(
    `INSERT INTO transitions (bug_id, at, from_status, to_status, worker, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    fix.bug_id,
    Date.now(),
    fix.status,
    status,
    WORKER,
    (extra.error as string) ?? null,
  );
}

async function step(fix: FixRow): Promise<void> {
  if (fix.cancel_requested) return transition(fix, 'cancelled');

  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (
          await withRetry(`agent:${fix.bug_id}`, () =>
            withStallTimeout(AGENT_STALL_MS, (beat) =>
              runFixAgent(bugOf(fix), {
                onProgress: () => {
                  beat();
                  void db.run(
                    `UPDATE fixes SET lease_until = ? WHERE bug_id = ?`,
                    Date.now() + LEASE_MS,
                    fix.bug_id,
                  );
                },
              }),
            ),
          )
        ).prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      if (Date.now() - fix.status_since > CI_DEADLINE_MS) {
        await escalate(bugOf(fix), `CI silent for 2h on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      if (Date.now() - fix.status_since > REVIEW_DEADLINE_MS) {
        await escalate(bugOf(fix), 'no review in 3 days');
        return transition(fix, 'escalated');
      }
      const event = await db.get<{approved: number}>(
        `SELECT approved FROM review_events WHERE bug_id = ? LIMIT 1`,
        fix.bug_id,
      );
      if (!event) return;
      if (event.approved) {
        const fresh = await db.get<{cancel_requested: number}>(
          `SELECT cancel_requested FROM fixes WHERE bug_id = ?`,
          fix.bug_id,
        );
        if (fresh!.cancel_requested) return transition(fix, 'cancelled');
        await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
        return transition(fix, 'merged');
      }
      await escalate(bugOf(fix), 'review declined');
      return transition(fix, 'escalated');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status, status_since)
         VALUES (?, ?, 'queued', ?)`,
      bug.id,
      bug.title,
      Date.now(),
    );
  }
}

async function claimStep(): Promise<FixRow | undefined> {
  return db.get<FixRow>(
    `UPDATE fixes SET leased_by = ?, lease_until = ?
      WHERE bug_id = (
        SELECT bug_id FROM fixes
         WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')
           AND (lease_until IS NULL OR lease_until < ?)
         LIMIT 1)
      RETURNING *`,
    WORKER,
    Date.now() + LEASE_MS,
    Date.now(),
  );
}

async function tick(): Promise<void> {
  await claimNewBugs();
  for (;;) {
    const fix = await claimStep();
    if (!fix) return;
    try {
      await step(fix);
    } catch (err) {
      await transition(fix, 'failed', {error: String(err)});
    } finally {
      await db.run(
        `UPDATE fixes SET leased_by = NULL, lease_until = NULL
          WHERE bug_id = ? AND leased_by = ?`,
        fix.bug_id,
        WORKER,
      );
    }
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.post('/fixes/:bugId/cancel', async (req, res) => {
  await db.run(
    `UPDATE fixes SET cancel_requested = 1 WHERE bug_id = ?`,
    req.params.bugId,
  );
  res.sendStatus(202);
});

// "What is it waiting on?" — a hand-written second description of the state
// machine, which must now be updated in lockstep with every case arm, forever.
// When an arm changes and this doesn't, the dashboard lies, silently.
function waitingOn(fix: FixRow): string {
  switch (fix.status) {
    case 'queued':
      return 'a worker, or the fix agent';
    case 'awaiting-ci':
      return `CI on ${fix.pr_url}`;
    case 'awaiting-review':
      return `a reviewer, until ${new Date(
        fix.status_since + REVIEW_DEADLINE_MS,
      ).toISOString()}`;
    default:
      return 'nothing — closed';
  }
}

app.get('/fixes/:bugId', async (req, res) => {
  const fix = await db.get<FixRow>(
    `SELECT * FROM fixes WHERE bug_id = ?`,
    req.params.bugId,
  );
  if (!fix) return res.sendStatus(404);
  const history = await db.all(
    `SELECT at, from_status, to_status, worker, detail
       FROM transitions WHERE bug_id = ? ORDER BY at`,
    req.params.bugId,
  );
  const attempts = await db.all(
    `SELECT key, count FROM attempts WHERE key LIKE ?`,
    `%:${req.params.bugId}`,
  );
  res.json({fix, history, attempts, waitingOn: waitingOn(fix)});
});

app.listen(8080);
```

**~330 lines.**

## v10 — but you probably want to deploy new code while fixes are in flight

Product asks: fixes should need _two_ approvals now. Easy — except thirty
fixes are sitting in `awaiting-review` right now, claimed under the
one-approval rule, and their reviewers were only ever asked for one. Apply the
new rule to them and they hang forever waiting for a second reviewer nobody
assigned. So the rule an execution runs under has to be pinned _to the row_ at
claim time: a `version` column, stamped by `claimNewBugs`, branched on in every
case arm whose behaviour changed — and mirrored in `waitingOn`, or the
dashboard starts lying immediately.

```sql
-- schema.sql (fixes gains version; other tables unchanged)
CREATE TABLE fixes (
  bug_id           TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  pr_url           TEXT,
  error            TEXT,
  status_since     INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  leased_by        TEXT,
  lease_until      INTEGER
);
```

```ts
// autofix.ts — v10: the state machine's states are now an interface between
// versions of this very program
import express from 'express';
import * as os from 'node:os';
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const AGENT_STALL_MS = 5 * 60_000;
const CI_DEADLINE_MS = 2 * 60 * 60_000;
const REVIEW_DEADLINE_MS = 3 * 24 * 60 * 60_000;
const LEASE_MS = 2 * 60_000;
const WORKER = `${os.hostname()}#${process.pid}`;
const VERSION = 2; // bumped on every behavioural change, forever

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  version: number;
  pr_url: string | null;
  error: string | null;
  status_since: number;
  cancel_requested: number;
  leased_by: string | null;
  lease_until: number | null;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

function withStallTimeout<T>(
  stallMs: number,
  run: (beat: () => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no heartbeat for ${stallMs}ms`)),
        stallMs,
      );
    };
    arm();
    run(arm).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?, status_since = ?${cols
      .map((c) => `, ${c} = ?`)
      .join('')}
      WHERE bug_id = ?`,
    status,
    Date.now(),
    ...Object.values(extra),
    fix.bug_id,
  );
  await db.run(
    `INSERT INTO transitions (bug_id, at, from_status, to_status, worker, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    fix.bug_id,
    Date.now(),
    fix.status,
    status,
    WORKER,
    (extra.error as string) ?? null,
  );
}

async function step(fix: FixRow): Promise<void> {
  if (fix.cancel_requested) return transition(fix, 'cancelled');

  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (
          await withRetry(`agent:${fix.bug_id}`, () =>
            withStallTimeout(AGENT_STALL_MS, (beat) =>
              runFixAgent(bugOf(fix), {
                onProgress: () => {
                  beat();
                  void db.run(
                    `UPDATE fixes SET lease_until = ? WHERE bug_id = ?`,
                    Date.now() + LEASE_MS,
                    fix.bug_id,
                  );
                },
              }),
            ),
          )
        ).prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      if (Date.now() - fix.status_since > CI_DEADLINE_MS) {
        await escalate(bugOf(fix), `CI silent for 2h on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      if (Date.now() - fix.status_since > REVIEW_DEADLINE_MS) {
        await escalate(bugOf(fix), 'no review in 3 days');
        return transition(fix, 'escalated');
      }
      const verdicts = (
        await db.all<{approved: number}>(
          `SELECT approved FROM review_events WHERE bug_id = ?`,
          fix.bug_id,
        )
      ).map((e) => e.approved !== 0);
      if (verdicts.includes(false)) {
        await escalate(bugOf(fix), 'review declined');
        return transition(fix, 'escalated');
      }
      // v2 wants two approvals. Rows claimed before that deploy keep the old
      // rule — their reviewers were only ever asked for one. This branch can
      // be deleted only when no open row carries version 1: a query someone
      // runs by hand, before every cleanup, or else.
      const needed = fix.version >= 2 ? 2 : 1;
      if (verdicts.filter(Boolean).length < needed) return;
      const fresh = await db.get<{cancel_requested: number}>(
        `SELECT cancel_requested FROM fixes WHERE bug_id = ?`,
        fix.bug_id,
      );
      if (fresh!.cancel_requested) return transition(fix, 'cancelled');
      await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
      return transition(fix, 'merged');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status, status_since, version)
         VALUES (?, ?, 'queued', ?, ?)`,
      bug.id,
      bug.title,
      Date.now(),
      VERSION,
    );
  }
}

async function claimStep(): Promise<FixRow | undefined> {
  return db.get<FixRow>(
    `UPDATE fixes SET leased_by = ?, lease_until = ?
      WHERE bug_id = (
        SELECT bug_id FROM fixes
         WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')
           AND (lease_until IS NULL OR lease_until < ?)
         LIMIT 1)
      RETURNING *`,
    WORKER,
    Date.now() + LEASE_MS,
    Date.now(),
  );
}

async function tick(): Promise<void> {
  await claimNewBugs();
  for (;;) {
    const fix = await claimStep();
    if (!fix) return;
    try {
      await step(fix);
    } catch (err) {
      await transition(fix, 'failed', {error: String(err)});
    } finally {
      await db.run(
        `UPDATE fixes SET leased_by = NULL, lease_until = NULL
          WHERE bug_id = ? AND leased_by = ?`,
        fix.bug_id,
        WORKER,
      );
    }
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.post('/fixes/:bugId/cancel', async (req, res) => {
  await db.run(
    `UPDATE fixes SET cancel_requested = 1 WHERE bug_id = ?`,
    req.params.bugId,
  );
  res.sendStatus(202);
});

function waitingOn(fix: FixRow): string {
  switch (fix.status) {
    case 'queued':
      return 'a worker, or the fix agent';
    case 'awaiting-ci':
      return `CI on ${fix.pr_url}`;
    case 'awaiting-review':
      // Version-aware too, or the dashboard lies about v1 rows.
      return `${fix.version >= 2 ? 'two reviewers' : 'a reviewer'}, until ${new Date(
        fix.status_since + REVIEW_DEADLINE_MS,
      ).toISOString()}`;
    default:
      return 'nothing — closed';
  }
}

app.get('/fixes/:bugId', async (req, res) => {
  const fix = await db.get<FixRow>(
    `SELECT * FROM fixes WHERE bug_id = ?`,
    req.params.bugId,
  );
  if (!fix) return res.sendStatus(404);
  const history = await db.all(
    `SELECT at, from_status, to_status, worker, detail
       FROM transitions WHERE bug_id = ? ORDER BY at`,
    req.params.bugId,
  );
  const attempts = await db.all(
    `SELECT key, count FROM attempts WHERE key LIKE ?`,
    `%:${req.params.bugId}`,
  );
  res.json({fix, history, attempts, waitingOn: waitingOn(fix)});
});

app.listen(8080);
```

**~350 lines.** The `version` column is forever, and so is the discipline:
every behavioural change from now on either adds a branch like this one or
silently misinterprets rows claimed under the old rules — and shows up twice,
because `waitingOn` describes the machine separately.

## v11 — but you probably want the ledger not to grow forever

Closed fixes and their audit trails accumulate without bound. Deleting them
sounds like a cron job until you remember that `fixes` is also the dedupe set:
delete a merged row while its bug is still on the hotlist, and `claimNewBugs`
re-claims it and opens a second PR for a bug that was fixed last month. So
`transition` stamps a `closed_at` on terminal statuses, and a sweeper deletes
on a window that is really a bet.

This is the last stage with a program, so here it is in full — the finished
artifact, twelve requirements later:

```sql
-- schema.sql — final form
CREATE TABLE fixes (
  bug_id           TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  pr_url           TEXT,
  error            TEXT,
  status_since     INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  leased_by        TEXT,
  lease_until      INTEGER,
  closed_at        INTEGER
);
CREATE TABLE attempts (
  key   TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
CREATE TABLE review_events (
  bug_id   TEXT NOT NULL,
  approved INTEGER NOT NULL
);
CREATE TABLE transitions (
  bug_id      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  worker      TEXT NOT NULL,
  detail      TEXT
);
```

```ts
// autofix.ts — v11, final form
import express from 'express';
import * as os from 'node:os';
import {db} from './db';
import {
  Bug,
  ciStatus,
  escalate,
  fetchHotlist,
  findOpenPr,
  merge,
  requestReview,
  runFixAgent,
} from './services';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;
const AGENT_STALL_MS = 5 * 60_000;
const CI_DEADLINE_MS = 2 * 60 * 60_000;
const REVIEW_DEADLINE_MS = 3 * 24 * 60 * 60_000;
const LEASE_MS = 2 * 60_000;
const RETAIN_CLOSED_MS = 30 * 24 * 60 * 60_000;
const WORKER = `${os.hostname()}#${process.pid}`;
const VERSION = 2;

const CLOSED = ['merged', 'escalated', 'failed', 'cancelled'];

interface FixRow {
  bug_id: string;
  title: string;
  status: string;
  version: number;
  pr_url: string | null;
  error: string | null;
  status_since: number;
  cancel_requested: number;
  leased_by: string | null;
  lease_until: number | null;
  closed_at: number | null;
}

const bugOf = (fix: FixRow): Bug => ({id: fix.bug_id, title: fix.title});

function isRetryable(err: unknown): boolean {
  const status = (err as {status?: number}).status;
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const {count} = (await db.get<{count: number}>(
      `INSERT INTO attempts (key, count) VALUES (?, 1)
         ON CONFLICT (key) DO UPDATE SET count = count + 1
         RETURNING count`,
      key,
    ))!;
    try {
      const result = await fn();
      await db.run(`DELETE FROM attempts WHERE key = ?`, key);
      return result;
    } catch (err) {
      if (!isRetryable(err) || count >= MAX_ATTEMPTS) throw err;
      await sleepMs(Math.min(1_000 * 2 ** count, 60_000));
    }
  }
}

function withStallTimeout<T>(
  stallMs: number,
  run: (beat: () => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no heartbeat for ${stallMs}ms`)),
        stallMs,
      );
    };
    arm();
    run(arm).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function transition(
  fix: FixRow,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (CLOSED.includes(status)) extra = {...extra, closed_at: Date.now()};
  const cols = Object.keys(extra);
  await db.run(
    `UPDATE fixes SET status = ?, status_since = ?${cols
      .map((c) => `, ${c} = ?`)
      .join('')}
      WHERE bug_id = ?`,
    status,
    Date.now(),
    ...Object.values(extra),
    fix.bug_id,
  );
  await db.run(
    `INSERT INTO transitions (bug_id, at, from_status, to_status, worker, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    fix.bug_id,
    Date.now(),
    fix.status,
    status,
    WORKER,
    (extra.error as string) ?? null,
  );
}

async function step(fix: FixRow): Promise<void> {
  if (fix.cancel_requested) return transition(fix, 'cancelled');

  switch (fix.status) {
    case 'queued': {
      const prUrl =
        (await findOpenPr(fix.bug_id)) ??
        (
          await withRetry(`agent:${fix.bug_id}`, () =>
            withStallTimeout(AGENT_STALL_MS, (beat) =>
              runFixAgent(bugOf(fix), {
                onProgress: () => {
                  beat();
                  void db.run(
                    `UPDATE fixes SET lease_until = ? WHERE bug_id = ?`,
                    Date.now() + LEASE_MS,
                    fix.bug_id,
                  );
                },
              }),
            ),
          )
        ).prUrl;
      return transition(fix, 'awaiting-ci', {pr_url: prUrl});
    }
    case 'awaiting-ci': {
      if (Date.now() - fix.status_since > CI_DEADLINE_MS) {
        await escalate(bugOf(fix), `CI silent for 2h on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      const ci = await withRetry(`ci:${fix.bug_id}`, () =>
        ciStatus(fix.pr_url!),
      );
      if (ci === 'pending') return;
      if (ci === 'red') {
        await escalate(bugOf(fix), `CI failed on ${fix.pr_url}`);
        return transition(fix, 'escalated');
      }
      await withRetry(`review:${fix.bug_id}`, () => requestReview(fix.pr_url!));
      return transition(fix, 'awaiting-review');
    }
    case 'awaiting-review': {
      if (Date.now() - fix.status_since > REVIEW_DEADLINE_MS) {
        await escalate(bugOf(fix), 'no review in 3 days');
        return transition(fix, 'escalated');
      }
      const verdicts = (
        await db.all<{approved: number}>(
          `SELECT approved FROM review_events WHERE bug_id = ?`,
          fix.bug_id,
        )
      ).map((e) => e.approved !== 0);
      if (verdicts.includes(false)) {
        await escalate(bugOf(fix), 'review declined');
        return transition(fix, 'escalated');
      }
      const needed = fix.version >= 2 ? 2 : 1;
      if (verdicts.filter(Boolean).length < needed) return;
      const fresh = await db.get<{cancel_requested: number}>(
        `SELECT cancel_requested FROM fixes WHERE bug_id = ?`,
        fix.bug_id,
      );
      if (fresh!.cancel_requested) return transition(fix, 'cancelled');
      await withRetry(`merge:${fix.bug_id}`, () => merge(fix.pr_url!));
      return transition(fix, 'merged');
    }
  }
}

async function claimNewBugs(): Promise<void> {
  for (const bug of await withRetry('hotlist', () => fetchHotlist('my-team'))) {
    await db.run(
      `INSERT OR IGNORE INTO fixes (bug_id, title, status, status_since, version)
         VALUES (?, ?, 'queued', ?, ?)`,
      bug.id,
      bug.title,
      Date.now(),
      VERSION,
    );
  }
}

async function claimStep(): Promise<FixRow | undefined> {
  return db.get<FixRow>(
    `UPDATE fixes SET leased_by = ?, lease_until = ?
      WHERE bug_id = (
        SELECT bug_id FROM fixes
         WHERE status IN ('queued', 'awaiting-ci', 'awaiting-review')
           AND (lease_until IS NULL OR lease_until < ?)
         LIMIT 1)
      RETURNING *`,
    WORKER,
    Date.now() + LEASE_MS,
    Date.now(),
  );
}

async function sweepClosed(): Promise<void> {
  // `fixes` is also the dedupe set. Thirty days is a bet that no merged bug
  // reappears on the hotlist after a month; when the bet loses, the symptom
  // is a duplicate PR and the cause is this function, which nobody will
  // suspect. (Bounding attempts and transitions is the same question again,
  // with the same non-answer.)
  await db.run(
    `DELETE FROM fixes
      WHERE status IN ('merged', 'escalated', 'failed', 'cancelled')
        AND closed_at < ?`,
    Date.now() - RETAIN_CLOSED_MS,
  );
  await db.run(
    `DELETE FROM transitions WHERE at < ?`,
    Date.now() - RETAIN_CLOSED_MS,
  );
}

async function tick(): Promise<void> {
  await claimNewBugs();
  await sweepClosed();
  for (;;) {
    const fix = await claimStep();
    if (!fix) return;
    try {
      await step(fix);
    } catch (err) {
      await transition(fix, 'failed', {error: String(err)});
    } finally {
      await db.run(
        `UPDATE fixes SET leased_by = NULL, lease_until = NULL
          WHERE bug_id = ? AND leased_by = ?`,
        fix.bug_id,
        WORKER,
      );
    }
  }
}

setInterval(tick, 5 * 60_000);

// ── the delivered half ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/webhooks/review', async (req, res) => {
  const {bugId, approved} = req.body as {bugId: string; approved: boolean};
  await db.run(
    `INSERT INTO review_events (bug_id, approved) VALUES (?, ?)`,
    bugId,
    approved ? 1 : 0,
  );
  res.sendStatus(204);
});

app.post('/fixes/:bugId/cancel', async (req, res) => {
  await db.run(
    `UPDATE fixes SET cancel_requested = 1 WHERE bug_id = ?`,
    req.params.bugId,
  );
  res.sendStatus(202);
});

function waitingOn(fix: FixRow): string {
  switch (fix.status) {
    case 'queued':
      return 'a worker, or the fix agent';
    case 'awaiting-ci':
      return `CI on ${fix.pr_url}`;
    case 'awaiting-review':
      return `${fix.version >= 2 ? 'two reviewers' : 'a reviewer'}, until ${new Date(
        fix.status_since + REVIEW_DEADLINE_MS,
      ).toISOString()}`;
    default:
      return 'nothing — closed';
  }
}

app.get('/fixes/:bugId', async (req, res) => {
  const fix = await db.get<FixRow>(
    `SELECT * FROM fixes WHERE bug_id = ?`,
    req.params.bugId,
  );
  if (!fix) return res.sendStatus(404);
  const history = await db.all(
    `SELECT at, from_status, to_status, worker, detail
       FROM transitions WHERE bug_id = ? ORDER BY at`,
    req.params.bugId,
  );
  const attempts = await db.all(
    `SELECT key, count FROM attempts WHERE key LIKE ?`,
    `%:${req.params.bugId}`,
  );
  res.json({fix, history, attempts, waitingOn: waitingOn(fix)});
});

app.listen(8080);
```

**~370 lines, four tables, three endpoints.** And this is the compressed
version — no logging, no config, no migration runner, `db` and `services`
elided, comments doing the work of design docs. In your repo, with real error
types and real review, call it a thousand.

## v12 — but you probably want to test any of this

There is no snapshot for this stage, because the code that would need to appear
is the problem. The logic is now smeared across a schema, a lease protocol, a
webhook server, a sweeper, and a version column — so testing "the 3-day review
timeout escalates" requires standing all of it up, and then defeating time:

```ts
// what testing one rule of the business logic now requires
beforeEach(async () => {
  db = await openMigratedTestDb(); // the real schema, or the test lies
  services = installServiceFakes(); // seven fakes, each with failure modes
  clock = installFakeClock(); // Date.now() is read in six places
  webhook = await startWebhookServer(db); // a real port, for the fake reviewer
  workers = [runWorker(db), runWorker(db)]; // two, or the lease bugs hide
});

it('escalates a fix nobody reviews for 3 days', async () => {
  services.hotlist.push({id: 'BUG-1', title: 'crash on save'});
  await advanceUntilStatus(db, 'BUG-1', 'awaiting-review'); // polls ticks…
  clock.advance(3 * 24 * 60 * 60_000 + 1);
  await advanceUntilStatus(db, 'BUG-1', 'escalated'); // …and hopes
});
```

The seams were never designed in, so the fake clock is installed globally under
code that wasn't written for it, `advanceUntilStatus` is a polling loop with its
own timeout, and the two-worker lease races — the bugs most worth testing — are
exactly the ones a test can't reproduce on demand. The tests that get written
mock so much they test the mocks.

## The tally

Twelve requirements, none exotic. Count what the 38-line tick function became:

- a schema: fixes, attempts, review_events, transitions — eleven columns on the
  main table, each one a lesson
- a claim protocol and an idempotency audit, redone once for crashes and again
  for leases
- a retry helper with persisted budgets
- a hand-rolled state machine that no longer states the spec anywhere
- a webhook server with a buffering rule that doubles as a lock
- a stall detector whose heartbeats also renew leases
- cancellation checks at the door of every arm, with a window that never fully
  closes
- a lease-based work queue with a tuned-by-incident timeout
- an audit log, and a `waitingOn` function that re-describes the state machine
  by hand
- a version column and a branch-per-behavioural-change discipline
- a retention sweep that gambles against the dedupe set
- and a test harness that has to defeat time itself

None of it is your product. All of it is load-bearing. And the five verbs and
two decisions you started with are no longer written down anywhere — they are
implied by the union of the case arms, which is exactly where the next bug
lives. Every team that ships one of these ends up here, because the ladder
wasn't optional: each rung was something you genuinely wanted.

## Or: write it in Tempo

Here is the same automation, whole, against this engine. Activities are the
only place I/O happens; workflows are deterministic orchestration the engine
can kill and replay at any `await`.

```ts
// activities.ts — ordinary async functions; the only place I/O is allowed
export async function fetchHotlist(hotlist: string): Promise<Bug[]> { /* … */ }
export async function runFixAgent(bug: Bug): Promise<{prUrl: string}> { /* … */ }
export async function ciStatus(prUrl: string): Promise<'pending' | 'green' | 'red'> { /* … */ }
export async function requestReview(prUrl: string): Promise<void> { /* … */ }
export async function merge(prUrl: string): Promise<void> { /* … */ }
export async function escalate(bug: Bug, why: string): Promise<void> { /* … */ }
```

```ts
// workflows.ts — deterministic; survives a crash at any await
import {
  byId,
  condition,
  createWorkflow,
  defineSignal,
  pollForever,
  proxyActivities,
  setHandler,
  sleep,
} from 'workflow-engine/workflow';
import * as tracker from './activities';

const act = proxyActivities(tracker, {
  retry: {maximumAttempts: 5, initialIntervalMs: 2_000},
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const reviewed = defineSignal('reviewed');

export const fixBug = createWorkflow('fixBug', async (bug: Bug) => {
  const {prUrl} = await act.runFixAgent(bug);

  let ci = await act.ciStatus(prUrl);
  while (ci === 'pending') {
    await sleep(MINUTE); // durable: survives restarts and deploys
    ci = await act.ciStatus(prUrl);
  }
  if (ci === 'red') return act.escalate(bug, `CI failed on ${prUrl}`);

  await act.requestReview(prUrl);
  let verdict: boolean | undefined;
  setHandler(reviewed, (ok: boolean) => void (verdict = ok));
  let expired = false;
  void sleep(3 * DAY).then(() => void (expired = true));
  await condition(() => verdict !== undefined || expired);

  if (verdict) return act.merge(prUrl);
  return act.escalate(
    bug,
    verdict === false ? 'review declined' : 'no review in 3 days',
  );
});

export const watchHotlist = createWorkflow('watchHotlist', (hotlist: string) =>
  pollForever({
    everyMs: 5 * MINUTE,
    poll: () => act.fetchHotlist(hotlist),
    differ: byId((bug: Bug) => bug.id),
    startFrom: 'new', // don't fix the 500-bug backlog on day one
    onAdded: (bug) =>
      void fixBug.detached([bug], {workflowId: `fix-${bug.id}`}),
  }),
);
```

```ts
// worker.ts — the deployable artifact, whole
import {Tempo} from 'workflow-engine';
import * as activities from './activities';
import {watchHotlist} from './workflows';

Tempo.startWorker({name: 'autofix', activities, workflows: {watchHotlist}});
```

Roughly the size of v0, and it reads like the spec again: first the fix, then
CI, then review, then the decision. The control flow is `async/await`, not a
status column — the straight-line program from page one is the one that ships.

Now walk back down the ladder:

- **v1, survive a restart** — the engine records an event history and rebuilds
  any execution by replaying the function against it. Kill the worker at any
  `await`; it resumes there. No schema, no status column: the _program counter_
  is what's durable.
- **v2, exactly once** — `workflowId: 'fix-BUG-4712'` is a claim, deduplicated
  at the server. However many pollers, replays, or restarts ask, there is one
  fix per bug. Activity effects are at-least-once with recorded outcomes — the
  honest contract, stated instead of discovered.
- **v3, retries** — `retry: {maximumAttempts: 5}` on the proxy. The budget is
  counted on the server against the execution record, so a worker dying
  mid-backoff doesn't reset it — and nothing is pinned waiting.
- **v4, waits longer than a process** — `sleep(3 * DAY)` is a durable timer,
  re-armed from history on restart. The straight line never inverts; there is
  no state machine to hand-roll because the function _is_ the state machine,
  checkpointed at every await.
- **v5, delivered answers** — `defineSignal` / `setHandler` / `condition`. A
  signal that arrives before the handler is set is buffered; correlation is the
  `workflowId`; your webhook shrinks to one line calling
  `client.signal('fix-BUG-4712', reviewed, true)`.
- **v6, deadlines and slow-vs-dead** — the timer raced with the condition,
  above, in two lines of ordinary code. For hung activities,
  `startToCloseTimeoutMs` bounds an attempt and `heartbeat()` lets the server
  tell slow from dead.
- **v7, cancellation** — `client.cancel('fix-BUG-4712')` unwinds the workflow
  through whatever it awaits and cascades to children by policy. No flag at the
  door of every arm.
- **v8, more machines** — run the worker binary more times; the server's task
  queues own leases, redelivery, and the two-workers-one-task race (replay
  makes the loser's work safe to discard). Your code doesn't change.
- **v9, seeing what it's doing** — `describe` returns status, history, and what
  an execution is _currently waiting on_, derived from the same history that
  drives replay — so it cannot drift from the truth the way a hand-written
  `waitingOn` does. The lifecycle log is structured JSON Lines.
- **v10, deploying mid-flight** — `patched('two-approvals')` records, per
  execution, which side of a code change it took, so old and new histories
  replay correctly from one source; `deprecatePatch` retires the branch. And
  when a change slips through unversioned, replay detects the divergence and
  stops rather than publishing a corrupted state.
- **v11, bounded storage** — `continueAsNew` sheds a long-lived workflow's
  history (`pollForever` does it for you); `--retain-closed-for-days` expires
  closed executions, and its docs state the dedupe trade-off you'd otherwise
  discover from a duplicate PR.
- **v12, testing** — the same workflow code runs in `createLocalRuntime()`,
  in-memory, no server, fast enough for the inner loop; `worker.js
--local=fixBug` smoke-tests the built artifact in CI. The determinism
  boundary that makes replay sound is the same seam that makes the logic
  testable — workflow code _can't_ read the wall clock, so time is the
  engine's to control, not a global to fake.

The ladder didn't get shorter — every rung is still real work. It's just that
each one is solved once, in the engine, behind the replay mechanism that makes
all of them the same problem: record what happened, and reconstruct any
execution from the record. That is the entire trick, and
[README.md](README.md) and the source walk through how it's built — this is a
reference implementation, small enough to actually read, so when you want to
know _why_ the durable version of your tick function can be forty lines again,
the answer is in the next file over.
