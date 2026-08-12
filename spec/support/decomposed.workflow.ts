/**
 * @fileoverview
 * A workflow decomposed into a helper, declaring its own activities.
 *
 * Named `*.workflow.ts` on purpose: that is what makes `tools/boundaries.ts` treat
 * it as workflow code, so this file is held to the determinism boundary — and its
 * value import of an activities module is only legal because the binding is handed
 * to `proxyActivities` and used nowhere else. Rename the file and the check stops
 * applying; reach for `payments` directly and lint fails.
 *
 * The worker in `spec/integration/decomposed_workflow.spec.ts` passes `workflows` and
 * no `activities` at all. Everything this workflow needs is registered by the act of
 * declaring it below.
 */

import {proxyActivities} from '../../src/workflow';
import * as payments from './payment_activities';

const act = proxyActivities(payments, {retry: {maximumAttempts: 1}});

/** The helper — the thing that makes a flat list at the entrypoint unmaintainable. */
async function chargeAndNotify(orderId: string): Promise<string> {
  const charged = await act.charge(orderId);
  const emailed = await act.emailReceipt(orderId);
  return `${charged}, then ${emailed}`;
}

export async function placeOrder(orderId: string): Promise<string> {
  return chargeAndNotify(orderId);
}
