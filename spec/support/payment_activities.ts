/**
 * @fileoverview
 * Activities for `decomposed.workflow.ts` — plain functions, no framework import.
 *
 * Deliberately a *separate* module from the workflow that calls them, because the
 * point of the case they support is that the worker entrypoint never names this file.
 */

export function charge(orderId: string): string {
  return `charged ${orderId}`;
}

export function emailReceipt(orderId: string): string {
  return `emailed ${orderId}`;
}
