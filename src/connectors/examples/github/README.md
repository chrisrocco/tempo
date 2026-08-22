# github (example connector)

The reference connector — copy this folder's shape when authoring a new one.
It wraps a handful of GitHub issue operations, chosen because together they
exercise every decision in the authoring guide
([`../../README.md`](../../README.md), "Authoring a new connector"):

| Operation     | Kind    | The lesson it carries                                                       |
| ------------- | ------- | --------------------------------------------------------------------------- |
| `getIssue`    | query   | The plain case.                                                             |
| `listIssues`  | query   | Bounded `limit`, defaulted `state`, and the pull-requests-in-issues gotcha. |
| `createIssue` | command | **Honestly `unsafe`**: GitHub has no dedupe identity for creation.          |
| `closeIssue`  | command | `natural` — closing a closed issue succeeds (converge-as-set).              |
| `addLabels`   | command | `natural` — adding a label an issue has is a no-op.                         |
| `issueClosed` | trigger | The issue-events feed: `id` is stable and ordered, so it is the cursor.     |

## Service facts (step 1 of the guide, answered)

- **Dedupe identity for creates: none.** GitHub issue creation has no
  idempotency key, so `createIssue` ships `'unsafe'` with the reason written
  down. This is the honest path when a service lacks the capability.
- **Ordered event feed: yes.** `GET /repos/{owner}/{repo}/issues/events` —
  event `id`s are stable and strictly increasing, which is exactly what the
  trigger contract needs.
- **Disposable container: marked issues in a dedicated fixture repository.**
  Certification never creates repos; it creates issues carrying a
  `cnx-test-{ns}` label _and_ a `[cnx-test-{ns}]` title prefix (two markers,
  because a label can be deleted out from under an issue; a title cannot).
  Point `GITHUB_FIXTURE_REPO` at a repo that exists only for this.

## Config

| Env var          | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `GITHUB_TOKEN`   | A token with `repo` scope on the fixture repository.    |
| `GITHUB_API_URL` | Defaulted to `https://api.github.com` (GHES: override). |

The live certification additionally needs `GITHUB_FIXTURE_REPO=owner/repo`.

## Running the live certification

Without credentials, tempo's suite still verifies everything that needs no
network — the catalogue renders completely and the plan registers full
coverage — and marks the live run pending. With them, the same spec certifies
against real GitHub:

```bash
GITHUB_TOKEN=… GITHUB_FIXTURE_REPO=you/connector-fixtures \
  npx tsx node_modules/jasmine/bin/jasmine.js \
  --config=spec/support/jasmine.json --filter="github example"
```

## Quirks worth knowing

- **The issues list includes pull requests.** `listIssues` filters them out
  (`pull_request` present ⇒ it is a PR). Every GitHub client relearns this.
- **403 is two different failures.** Plain 403 is `denied`; 403 with
  `x-ratelimit-remaining: 0` is `unavailable`, because waiting fixes it and
  the engine should retry. `client.ts#mapError` is the one place that knows.
- **The events feed can lag by a moment.** The delivery-truth certification
  polls right after causing the event; a rare rerun can lose that race.
- **One page per poll.** The trigger reads one page of events per cycle and
  sorts ascending to keep the cursor contract; a production connector for a
  busy repository would paginate until it passes the cursor.

## In a consumer repo, two files differ

This example lives inside tempo, so it adapts the prescribed shape in two
spots: `github.live.ts` exports a plan **factory** (a consumer repo would make
it the `github.live.spec.ts` that runs it), and the token-gated runner lives in
`spec/connectors/github_example.spec.ts`. Everything else — `connector.ts`,
`client.ts`, `schemas.ts`, `fixtures.ts`, this README — is exactly the folder a
new connector should have.
