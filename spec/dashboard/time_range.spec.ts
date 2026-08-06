/**
 * @fileoverview
 * What the listing's time ranges mean.
 *
 * Small enough to look like it needs no spec, which is the reason it has one:
 * every value here is a duration written twice — once as a name a reader
 * trusts, once as arithmetic — and a `24h` that resolves to a minute is a
 * filter that lies rather than one that fails.
 *
 * Runs without a browser because `time_range.ts` touches no DOM.
 */

import 'jasmine';
import {
  TIME_RANGES,
  isTimeRange,
  rangeLabel,
  rangeStart,
  type TimeRange,
} from '../../dashboard/app/time_range';

/** A fixed clock, so a window is checked against arithmetic and not against now. */
const NOON = Date.parse('2026-08-05T12:00:00.000Z');

describe('dashboard time ranges — what each one covers', () => {
  it('reaches back by the duration its name states', () => {
    expect(rangeStart('15m', NOON)).toBe(Date.parse('2026-08-05T11:45:00Z'));
    expect(rangeStart('1h', NOON)).toBe(Date.parse('2026-08-05T11:00:00Z'));
    expect(rangeStart('24h', NOON)).toBe(Date.parse('2026-08-04T12:00:00Z'));
    expect(rangeStart('7d', NOON)).toBe(Date.parse('2026-07-29T12:00:00Z'));
  });

  it('starts in the past for every range it offers', () => {
    for (const range of TIME_RANGES)
      expect(rangeStart(range, NOON)).toBeLessThan(NOON);
  });

  it('orders the ranges shortest first, as the control presents them', () => {
    const starts = TIME_RANGES.map((range) => rangeStart(range, NOON));
    for (let i = 1; i < starts.length; i++)
      expect(starts[i]!).toBeLessThan(starts[i - 1]!);
  });

  it('gives every range words to appear as', () => {
    for (const range of TIME_RANGES)
      expect(rangeLabel(range)).not.toBe('' as string);
  });
});

describe('dashboard time ranges — reading one from a URL', () => {
  it('accepts every range the dashboard offers', () => {
    for (const range of TIME_RANGES) expect(isTimeRange(range)).toBe(true);
  });

  it('rejects a missing parameter, which is what an unfiltered listing has', () => {
    expect(isTimeRange(null)).toBe(false);
    expect(isTimeRange('')).toBe(false);
  });

  /**
   * The guard is what keeps `parseRoute` total. A duration that looks plausible
   * but is not offered has to be rejected rather than half-understood, or the
   * listing would silently apply a window nobody chose.
   */
  it('rejects a duration it does not offer, however plausible', () => {
    expect(isTimeRange('30m')).toBe(false);
    expect(isTimeRange('1H')).toBe(false);
    expect(isTimeRange('1754400000000')).toBe(false);
  });

  it('narrows the type, so a URL value can be used as a range', () => {
    const value: string | null = '24h';
    if (!isTimeRange(value)) throw new Error('expected a range');
    const range: TimeRange = value;
    expect(rangeStart(range, NOON)).toBe(NOON - 86_400_000);
  });
});
