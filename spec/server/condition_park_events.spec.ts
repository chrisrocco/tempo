/**
 * @fileoverview
 * `conditionParked` / `conditionUnparked`: waiting, in history.
 *
 * A `condition()` writes no history *by design* — that is what makes it free — and
 * the cost was that an execution waiting correctly and an execution wedged were
 * identical from events alone: a running record whose last event is arbitrarily
 * old. `ParkedCondition` answers that for right now and cannot answer it about
 * yesterday, which is what a timeline needs.
 *
 * The design risk is not the reporting, it is the cost. `condition` is re-evaluated
 * at every activation, so the one thing these events must never do is scale with
 * how often a workflow is woken. They record transitions, and the tests below pin
 * that as hard as they pin the events themselves.
 */

import {createLocalRuntime} from '../../src';
import {MemoryHistoryStore} from '../../src/server';
import type {
  ConditionParkedEvent,
  ConditionUnparkedEvent,
} from '../../src/protocol';
import {condition, setHandler} from '../../src/workflow';

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function parkEvents(
  rec: {history: {type: string}[]} | undefined,
): (ConditionParkedEvent | ConditionUnparkedEvent)[] {
  return (rec?.history ?? []).filter(
    (ev): ev is ConditionParkedEvent | ConditionUnparkedEvent =>
      ev.type === 'conditionParked' || ev.type === 'conditionUnparked',
  );
}

const go = 'go';
const nudge = 'nudge';

describe('a parked condition in history', () => {
  it('records the park while the workflow is still waiting', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('waiter', async () => {
        await condition(() => false);
        return 'never';
      })
      .start('waiter', undefined, {workflowId: 'cp-1'});
    await wait(150);

    // The state this whole pair exists for: running, nothing pending, nothing
    // owed — and now something in history that says so rather than a silence
    // indistinguishable from a wedged execution.
    const events = parkEvents(await store.get('cp-1'));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('conditionParked');
    expect(typeof events[0]!.condSeq).toBe('number');
    expect((events[0] as ConditionParkedEvent).site).toContain(
      'condition_park_events.spec',
    );
  });

  it('closes the span when the condition is satisfied', async () => {
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'waiter',
      async () => {
        let ready = false;
        setHandler(go, () => {
          ready = true;
        });
        await condition(() => ready);
        return 'went';
      },
    );
    const handle = rt.start<string>('waiter', undefined, {workflowId: 'cp-2'});
    await wait(150);
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went');

    const events = parkEvents(await store.get('cp-2'));
    expect(events.map((e) => e.type)).toEqual([
      'conditionParked',
      'conditionUnparked',
    ]);
    // Same id on both ends, which is what makes the pair a span rather than two
    // unrelated facts — and what a workflow parking twice on the same line needs.
    expect(events[0]!.condSeq).toBe(events[1]!.condSeq);
  });

  it('appends nothing for an activation that leaves the park unchanged', async () => {
    // The property the design lives or dies on. A signal-driven workflow is woken
    // constantly by signals that do not satisfy it; an event per evaluation would
    // put history in proportion to that, which is the one thing it must not do.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'patient',
      async () => {
        let ready = false;
        let nudges = 0;
        setHandler(go, () => {
          ready = true;
        });
        setHandler(nudge, () => {
          nudges += 1;
        });
        await condition(() => ready);
        return `went after ${nudges}`;
      },
    );
    const handle = rt.start<string>('patient', undefined, {workflowId: 'cp-3'});
    await wait(120);
    for (let i = 0; i < 5; i++) {
      handle.signal('nudge');
      await wait(20);
    }
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went after 5');

    // Five wake-ups that changed nothing, and one park plus one unpark to show
    // for the whole run.
    const events = parkEvents(await store.get('cp-3'));
    expect(events.map((e) => e.type)).toEqual([
      'conditionParked',
      'conditionUnparked',
    ]);
  });

  it('records every condition when more than one is outstanding', async () => {
    const store = new MemoryHistoryStore();
    createLocalRuntime({historyStore: store})
      .registerWorkflow('two', async () => {
        await Promise.all([condition(() => false), condition(() => false)]);
        return 'never';
      })
      .start('two', undefined, {workflowId: 'cp-4'});
    await wait(150);

    const events = parkEvents(await store.get('cp-4'));
    expect(events.length).toBe(2);
    // Distinct ids, from `condSeq` — which is not the command counter, so these
    // two events share no numbering with any marker in the same history.
    expect(new Set(events.map((e) => e.condSeq)).size).toBe(2);
  });

  it('stamps the declared awaiting on the park, and appends nothing while it survives', async () => {
    // The live parked state forgets an answered wait; this is where "what was
    // it waiting for" survives for the reader asking after the fact. And the
    // stamp must inherit the transition rule: an awaiting is re-reported on
    // every task the park survives, and must compare equal each time rather
    // than reopening the span.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'gate',
      async () => {
        let ready = false;
        let nudges = 0;
        setHandler(go, () => {
          ready = true;
        });
        setHandler(nudge, () => {
          nudges += 1;
        });
        await condition(() => ready, {
          awaiting: {kind: 'approval', signal: 'go'},
        });
        return `went after ${nudges}`;
      },
    );
    const handle = rt.start<string>('gate', undefined, {workflowId: 'cp-6'});
    await wait(120);
    for (let i = 0; i < 3; i++) {
      handle.signal('nudge');
      await wait(20);
    }
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went after 3');

    const events = parkEvents(await store.get('cp-6'));
    // One span, not one per wake-up — same guarantee as an undeclared park.
    expect(events.map((e) => e.type)).toEqual([
      'conditionParked',
      'conditionUnparked',
    ]);
    expect((events[0] as ConditionParkedEvent).awaiting).toEqual({
      kind: 'approval',
      signal: 'go',
    });
  });

  it('writes nothing at all for a workflow that never parks', async () => {
    // The common case. `recordParked`'s guard already skipped the store write for
    // it, and the events inherit that: most workflows pay nothing.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'plain',
      async () => 'done',
    );
    await expectAsync(
      rt.start<string>('plain', undefined, {workflowId: 'cp-5'}).result(),
    ).toBeResolvedTo('done');

    expect(parkEvents(await store.get('cp-5')).length).toBe(0);
  });
});

describe('what the park events must not disturb', () => {
  it('leaves the command sequence untouched', async () => {
    // `condSeq` is deliberately separate from the command `seq` counter so parking
    // never perturbs command numbering. These events carry `condSeq` and no `seq`
    // precisely so that stays true once parking is written down.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'mixed',
      async () => {
        let ready = false;
        setHandler(go, () => {
          ready = true;
        });
        await condition(() => ready);
        return 'went';
      },
    );
    const handle = rt.start<string>('mixed', undefined, {workflowId: 'cq-1'});
    await wait(150);
    handle.signal('go');
    await expectAsync(handle.result()).toBeResolvedTo('went');

    const history = (await store.get('cq-1'))!.history;
    // No command was issued, so no marker exists and nothing in this history
    // carries a command seq at all.
    expect(history.some((e) => 'seq' in e)).toBe(false);
  });

  it('is ignored by replay, so a resumed execution is unaffected', async () => {
    // These resolve no waiter and suppress no command. A workflow that parks,
    // unparks, parks again and finally completes replays over every one of them on
    // its last task — a divergence would surface as a failed execution here.
    const store = new MemoryHistoryStore();
    const rt = createLocalRuntime({historyStore: store}).registerWorkflow(
      'twice',
      async () => {
        let first = false;
        let second = false;
        setHandler(go, () => {
          first = true;
        });
        setHandler(nudge, () => {
          second = true;
        });
        await condition(() => first);
        await condition(() => second);
        return 'both';
      },
    );
    const handle = rt.start<string>('twice', undefined, {workflowId: 'cq-2'});
    await wait(120);
    handle.signal('go');
    await wait(80);
    handle.signal('nudge');
    await expectAsync(handle.result()).toBeResolvedTo('both');

    const events = parkEvents(await store.get('cq-2'));
    // Two distinct parks, each closed — not one span covering both waits.
    expect(events.map((e) => e.type)).toEqual([
      'conditionParked',
      'conditionUnparked',
      'conditionParked',
      'conditionUnparked',
    ]);
    expect(events[0]!.condSeq).not.toBe(events[2]!.condSeq);
  });
});
