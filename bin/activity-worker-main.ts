// Deployable process main: an activity worker. Stateless — it polls the server
// for activity tasks, runs the activity function (the only place I/O happens), and
// reports back. Activity *implementations* are loaded from WORKER_MODULE (a module
// exporting `registerActivities(registry)`). Env: SERVER_URL, WORKER_MODULE.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteService } from '../src/services';
import {
  createActivityRegistry,
  createActivityWorker,
  runActivityWorker,
  type ActivityRegistry,
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
    registerActivities(registry: ActivityRegistry): void;
  };
  const registry = createActivityRegistry();
  mod.registerActivities(registry);

  const service = createRemoteService(serverUrl);
  const loop = runActivityWorker(service, createActivityWorker(registry));
  console.log('ACTIVITY_WORKER_READY');

  async function stop(): Promise<void> {
    await loop.stop();
    process.exit(0);
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
