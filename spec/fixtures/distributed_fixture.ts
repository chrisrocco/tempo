// Workflow + activity definitions loaded by the worker process mains in the
// distributed integration test (via WORKER_MODULE).
import type { WorkflowFn } from '../../src/core';
import type { ActivityFn, ActivityRegistry, WorkflowRegistry } from '../../src/worker';
import { runActivity } from '../../src/workflow';

const greeter: WorkflowFn = async () => runActivity<string>('greet', 'world');
const greet: ActivityFn = (name: string) => `hi ${name}`;

export function registerWorkflows(registry: WorkflowRegistry): void {
  registry.set('greeter', greeter);
}

export function registerActivities(registry: ActivityRegistry): void {
  registry.set('greet', greet);
}
