## Objective

I want to hash out the developer jounrney for bundling and deploying the workflows.

## Assumptions / Constraints

- The workflows will be deployed on developers' Linux workstation machines (maybe container VMs later)
- The build system we'll ultimately be using is Blaze

## Requirements

The build & deploy user journey should look like this:

1.  Import the 'tempo' library in a TypeScript project
2.  Define their workflows
3.  Write a single, simple entrypoint file like 'deploy.ts' or 'worker.ts' (doesn't matter what they name it)
4.  They use the Tempo CLI to deploy and re-deploy the workers (maybe need to build the binaries again)

QUESTION: Can the CLI also `blaze build` the entrypoint for them, or do they have to do that separately?

Even though we're using blaze in practice, this approach shouldn't be coupled to blaze. I.e. it should work without blaze too.

I want the entrypoint to be a single, clean call into the library's API; something like this:

```ts
import {Tempo} from '@tempo'
import {activities} from './foo/activities'
import {workflows} from './foo/workflows'

Tempo.startWorker({
    activities,
    workflows,
})
```

NOTE: This is different to how it works at the time of writing:

- Currently, our bin/* workers take an environment variable that points at a raw TypeScript file
  - This would be infeasible in a build system like Blaze
  - For that reason, I think we need to invert the deps and have the user authored code produce the worker binary

We should also think about the installation story. Currently, the developer guides say to define three separate systemd services (Server, Activity Worker, Workflow Worker), but that's too much manual work.

QUESTION: What are our options? Do we need an installation script to generate those systemd service configs?

Here are some CLI methods we probably will need:

- [ ] tempo deploy --worker=??? // also will re-deploy a new version
- [ ] tempo status // shows the full status of the services (server, workers)
- [ ] tempo start <workflow-id> <args> [--wait] // Starts a new workflow
- [ ] tempo cancel <workflow-id>
- [ ] ...leave your suggestions here

Open Questions:

- [ ] Can the CLI also handle the installation script?

## Output

Let's create a focused developer guide for `Build and Deploy a Workflow`.
Replace the quickstart with this one - we are re-working it.

This forward-looking guide will give us the best possible feel for the developer experience. We'll use that as our anchor as we discuss all possibilities and make decisions.

Once we like that document, we can implement the changes.
