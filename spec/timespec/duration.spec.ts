/**
 * @fileoverview
 * The duration grammar. Exhaustive on the rejections in particular, because the
 * parser's promise is that a bad string fails at the line that wrote it — every
 * input it lets through becomes a number nobody re-checks.
 */

import {durationToMs} from '../../src/timespec';

describe('durationToMs — the string grammar', () => {
  it('parses each unit, short and long form alike', () => {
    expect(durationToMs('250ms')).toBe(250);
    expect(durationToMs('90s')).toBe(90_000);
    expect(durationToMs('30 minutes')).toBe(1_800_000);
    expect(durationToMs('5m')).toBe(300_000);
    expect(durationToMs('2 hours')).toBe(7_200_000);
    expect(durationToMs('1h')).toBe(3_600_000);
    expect(durationToMs('3 days')).toBe(259_200_000);
    expect(durationToMs('1w')).toBe(604_800_000);
  });

  it('sums multiple terms, so composite spans read the way they are said', () => {
    expect(durationToMs('1h 30m')).toBe(5_400_000);
    expect(durationToMs('1 hour 30 minutes')).toBe(5_400_000);
    expect(durationToMs('1m30s')).toBe(90_000);
  });

  it('accepts decimals and rounds the total to a whole millisecond', () => {
    expect(durationToMs('1.5s')).toBe(1_500);
    expect(durationToMs('1.5 days')).toBe(129_600_000);
    expect(durationToMs('0.0004ms')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(durationToMs('30 Minutes')).toBe(1_800_000);
    expect(durationToMs('1H')).toBe(3_600_000);
  });

  it('accepts zero, which is a meaningful timer', () => {
    // `sleep(0)` is a task boundary in this engine, so `'0 seconds'` must be one too.
    expect(durationToMs('0s')).toBe(0);
  });

  it('passes numbers through untouched — they already are milliseconds', () => {
    expect(durationToMs(250)).toBe(250);
    expect(durationToMs(0)).toBe(0);
  });

  it('rejects a bare number in a string, which lost its unit somewhere', () => {
    expect(() => durationToMs('500')).toThrowError(/cannot parse duration/);
  });

  it('rejects the empty string', () => {
    expect(() => durationToMs('')).toThrowError(/cannot parse duration/);
    expect(() => durationToMs('   ')).toThrowError(/cannot parse duration/);
  });

  it('rejects unknown units by name', () => {
    expect(() => durationToMs('5 fortnights')).toThrowError(
      /unknown unit "fortnights"/,
    );
  });

  it('rejects months and years as calendar arithmetic, not spans', () => {
    // The pointed error, not a generic one: '1 month' is the request a duration
    // cannot honestly carry, and the message says where that need is served.
    expect(() => durationToMs('1 month')).toThrowError(/calendar arithmetic/);
    expect(() => durationToMs('2 years')).toThrowError(/calendar arithmetic/);
    expect(() => durationToMs('1mo')).toThrowError(/calendar arithmetic/);
  });

  it('rejects a string any part of which did not parse', () => {
    // Silently ignoring the unparsed remainder would make '5m and 3s' mean 5
    // minutes — a wrong number produced from a readable sentence.
    expect(() => durationToMs('5m and 3s')).toThrowError(
      /cannot parse duration/,
    );
    expect(() => durationToMs('-5m')).toThrowError(/cannot parse duration/);
  });
});
