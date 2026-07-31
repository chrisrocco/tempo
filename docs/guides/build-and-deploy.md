# Build and Deploy a Workflow

> **Forward-looking.** This is the target API, not what ships today. It is the
> contract we are designing toward
> ([`planning/sprints/01-deployment-api.md`](../../planning/sprints/01-deployment-api.md)).

## 1. Write activities

Plain exported functions. All I/O lives here.

```ts
// src/activities.ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

## 2. Write workflows

Deterministic orchestration. Reach activities through `proxyActivities`, typed off
the activity module.

```ts
// src/workflows.ts
import { proxyActivities } from '@tempo/workflow';
import type * as activities from './activities';

const { greet } = proxyActivities<typeof activities>({
  retry: { maximumAttempts: 3 },
});

export async function greeter(name: string): Promise<string> {
  return greet(name);
}
```

## 3. Write the entrypoint

One file. It becomes the worker binary.

```ts
// src/worker.ts
import { Tempo } from '@tempo';
import * as activities from './activities';
import * as workflows from './workflows';

Tempo.startWorker({
  name: 'greeter',
  activities,
  workflows,
});
```

## 4. Build

Any build system, or the bundled one.

```bash
blaze build //myproject:worker      # → blaze-bin/myproject/worker
tempo build ./src/worker.ts         # → .tempo/build/worker
```

## 5. Deploy

Install the server once, then deploy the worker binary. Re-run `deploy` to ship a
new version.

```bash
tempo server install --port=7233 --data-dir=~/.local/share/tempo/data

tempo deploy ./blaze-bin/myproject/worker \
  --workflow-replicas=1 \
  --activity-replicas=4
```

Or run it in the foreground instead, with nothing installed:

```bash
tempo up ./blaze-bin/myproject/worker   # Ctrl-C to stop
```

## 6. Run workflows

```bash
tempo start greeter world --wait
tempo result <workflow-id>
tempo signal <workflow-id> diff '{"bugId":"123","action":"add"}'
tempo cancel <workflow-id>
tempo status
```

---

## API surface

### Library

```ts
proxyActivities<A>(options?): A       // typed activity handle, for workflow code

Tempo.startWorker({
  name: string,       // service identity
  workflows: object,  // name -> workflow fn (a module namespace)
  activities: object, // name -> activity fn (a module namespace)
});
```

Deployment config is not passed in code — the environment supplies it.

### Worker binary

| Input              | Values                              | Effect                                              |
| ------------------ | ----------------------------------- | --------------------------------------------------- |
| `TEMPO_SERVER_URL` | URL                                 | Server to connect to (default `127.0.0.1:7233`)     |
| `TEMPO_ROLE`       | `workflow` \| `activity` \| _unset_ | Which poll loop to run; unset runs both             |
| `--describe`       | —                                   | Print `{name, workflows, activities}` JSON and exit |

### CLI

| Command                           | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `tempo build <entry>`             | Build an entrypoint into a binary          |
| `tempo server install`            | Install + start the server                 |
| `tempo deploy <binary>`           | Install/update a worker, roll its replicas |
| `tempo up <binary>`               | Run server + worker in the foreground      |
| `tempo status`                    | Health of server + each worker role        |
| `tempo start <workflow> [args]`   | Start a workflow (`--wait` for the result) |
| `tempo result <id>`               | Fetch an outcome                           |
| `tempo signal <id> <name> <json>` | Send a signal                              |
| `tempo cancel <id>`               | Request cancellation                       |
| `tempo logs <name> [--role=]`     | Tail a worker role's logs                  |
| `tempo rollback <name>`           | Revert to the previous version             |

**`server install` flags**

| Flag              | Default | Meaning                       |
| ----------------- | ------- | ----------------------------- |
| `--port=N`        | 7233    | Listen port                   |
| `--data-dir=PATH` | _unset_ | Durable store; unset = memory |

**`deploy` flags**

| Flag                    | Default | Meaning                  |
| ----------------------- | ------- | ------------------------ |
| `--workflow-replicas=N` | 1       | Workflow worker replicas |
| `--activity-replicas=N` | 2       | Activity worker replicas |
