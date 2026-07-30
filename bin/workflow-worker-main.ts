// Deployable process main: a workflow worker. Stateless — it polls the server for
// workflow tasks, replays (core), and responds. Workflow *types* are loaded from
// WORKER_MODULE (a module exporting `registerWorkflows(registry)`). Env:
// SERVER_URL, WORKER_MODULE.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteService } from '../src/services';
import {
  createWorkflowRegistry,
  createWorkflowWorker,
  runWorkflowWorker,
  type WorkflowRegistry,
} from '../src/worker';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const serverUrl = requireEnv('SERVER_URL');
  const modulePath = requireEnv('WORKER_MODULE');

  const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    registerWorkflows(registry: WorkflowRegistry): void;
  };
  const registry = createWorkflowRegistry();
  mod.registerWorkflows(registry);

  const service = createRemoteService(serverUrl);
  const loop = runWorkflowWorker(service, createWorkflowWorker(registry));
  console.log('WORKFLOW_WORKER_READY');

  const stop = async (): Promise<void> => { await loop.stop(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
