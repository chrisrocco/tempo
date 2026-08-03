/**
 * @fileoverview
 * Unit test for the in-memory durable timer service: firing, cancellation, and
 * the startup recovery sweep. Uses small real delays (the adapter arms real
 * setTimeouts) and a short wait to observe firing.
 */

import {MemoryTimerService} from '../../src/server/memory/memory_timer_service';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('MemoryTimerService', () => {
  it('fires a scheduled timer with its (workflowId, seq)', async () => {
    const svc = new MemoryTimerService();
    const fired: Array<[string, number]> = [];
    svc.onFire((workflowId, seq) => fired.push([workflowId, seq]));

    svc.schedule('wf-1', 3, 5);
    await wait(30);

    expect(fired).toEqual([['wf-1', 3]]);
  });

  it('does not fire a cancelled timer', async () => {
    const svc = new MemoryTimerService();
    const fired: number[] = [];
    svc.onFire((_workflowId, seq) => fired.push(seq));

    svc.schedule('wf-1', 1, 5);
    svc.cancel('wf-1', 1);
    await wait(30);

    expect(fired).toEqual([]);
  });

  it('re-arms timers on recover (the startup sweep)', async () => {
    const svc = new MemoryTimerService();
    const fired: number[] = [];
    svc.onFire((_workflowId, seq) => fired.push(seq));

    svc.schedule('wf-1', 7, 5);
    svc.recover(); // simulates a restart re-arming the durable table
    await wait(30);

    expect(fired).toEqual([7]); // fires exactly once, not twice
  });
});
