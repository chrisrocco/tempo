/**
 * @fileoverview
 * `idempotency: 'keyed'` — the third answer to double delivery, for services
 * that accept an idempotency key but offer no natural dedupe shape.
 *
 * The mechanism under test is small and exact: the definition declares
 * `key(input)`, the activity wrapper derives the key from the *parsed* input
 * and hands it to the handler as a third argument, and — because both
 * deliveries of one recorded command carry the same input — the derived key is
 * identical, so a service that honors it produces one effect. Everything here
 * runs engine-free (`direct()` and plans register nothing), the same way the
 * live harness exercises the identical code path in production.
 */

import {
  catalogue,
  command,
  defineConnector,
  ops,
  planLiveSuite,
  t,
  type LiveFixtures,
} from '../../src/connectors';

/** The fake service: it dedupes on the key, as a keyed service must. */
interface PayCtx {
  charge(key: string, orderId: string): {chargeId: string};
}

const NO_FIXTURES: LiveFixtures<Record<string, never>> = {
  provision: () => ({}),
  destroy: () => undefined,
  sweep: () => 0,
};

describe('connectors — keyed idempotency', () => {
  const ledger = new Map<string, string>(); // key -> orderId, one entry per key
  const seenKeys: (string | undefined)[] = [];
  const {command: payCommand} = ops<PayCtx>();

  const payments = defineConnector({
    name: 'payments',
    description: 'A fake payment service that honors idempotency keys.',
    config: t.object({}),
    context: () => ({
      charge(key: string, orderId: string) {
        if (!ledger.has(key)) ledger.set(key, orderId); // service-side dedupe
        return {chargeId: `ch-${key}`};
      },
    }),
    commands: {
      charge: payCommand({
        description: 'Charge an order once, however many times it is asked.',
        idempotency: 'keyed',
        key: (input) => `charge/${input.orderId}`,
        input: t.object({orderId: t.string()}),
        output: t.object({chargeId: t.string()}),
        handler: (input, svc, idempotencyKey) => {
          seenKeys.push(idempotencyKey);
          // The handler's one keyed obligation: send the key to the service.
          return svc.charge(idempotencyKey!, input.orderId);
        },
      }),
    },
  });

  it("refuses a 'keyed' command that declares no key rule", () => {
    expect(() =>
      command({
        description: 'keyed in name only',
        idempotency: 'keyed',
        input: t.object({}),
        output: t.object({}),
        handler: () => ({}),
      }),
    ).toThrowError(/key\(input\)/);
  });

  it('derives the key from input, and the double delivery lands once', async () => {
    const direct = payments.direct();
    const first = await direct.command.charge({orderId: 'o-42'});
    // The retry the engine will eventually produce: same input, delivered again.
    const second = await direct.command.charge({orderId: 'o-42'});

    expect(seenKeys).toEqual(['charge/o-42', 'charge/o-42']); // deterministic
    expect(ledger.size).toBe(1); // one effect
    expect(second.chargeId).toBe(first.chargeId);
  });

  it("catalogues as 'keyed' — retryable, and not an unsafe flag", () => {
    const entry = catalogue([payments]).find((e) => e.name === 'charge');
    expect(entry?.idempotency).toBe('keyed');
    expect(entry?.unsafeBecause).toBeUndefined();
  });

  it('the live harness owes keyed commands a certification', async () => {
    // Registered with nothing: coverage must fail naming the keyed command —
    // 'keyed' is a claim about the service, so it is certified, never exempt.
    const bare = planLiveSuite(payments, NO_FIXTURES, () => {});
    const coverage = bare.cases[bare.cases.length - 1]!;
    await expectAsync(coverage.run()).toBeRejectedWithError(/charge/);

    // And the registrar accepts one (unlike 'unsafe', which it refuses).
    const certified = planLiveSuite(payments, NO_FIXTURES, (s) => {
      s.command('charge', {
        act: (ctx) => ctx.direct.command.charge({orderId: ctx.key}),
        probe: (ctx) => ({
          effects: [...ledger.keys()].filter((k) => k.includes(ctx.key)).length,
        }),
      });
    });
    const covered = certified.cases[certified.cases.length - 1]!;
    await expectAsync(covered.run()).toBeResolved();
  });
});
