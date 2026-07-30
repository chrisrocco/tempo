// Drives the motivating example end to end against LocalService: spawn a monitor
// per bug, cancel one on removal, then stop (which cancels the survivors). The
// test terminating at all is itself proof cancellation works — the child monitors
// loop forever otherwise.
import { bugHotlistRuntime } from '../../examples/bug_hotlist_monitor';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('example — bug hotlist monitor', () => {
  it('monitors bugs, cancels on removal, and stops cleanly', async () => {
    const checks: string[] = [];
    const rt = bugHotlistRuntime((bugId) => checks.push(bugId));

    const handle = rt.start<string[]>('hotlistMonitor');
    handle.signal('diff', { bugId: 'BUG-1', action: 'add' });
    handle.signal('diff', { bugId: 'BUG-2', action: 'add' });
    await wait(15); // let the monitors run

    handle.signal('diff', { bugId: 'BUG-1', action: 'remove' }); // cancels BUG-1's monitor
    await wait(10);

    handle.signal('stop'); // cancels BUG-2's monitor and returns

    const monitored = await handle.result();
    expect(monitored).toEqual(['BUG-1', 'BUG-2']);
    expect(checks.length).toBeGreaterThan(0); // the monitors actually did work
  });
});
