/**
 * @fileoverview
 * That choosing a palette survives a reload, and that failing to remember one
 * never costs more than the preference itself.
 *
 * The cases worth pinning down are the failures: `localStorage` throws rather
 * than returning null when storage is disabled or a private-mode quota is
 * exhausted, and an unguarded read would take the whole dashboard down over a
 * colour. Neither is reachable from a browser without disabling storage.
 */

import {
  DEFAULT_THEME,
  STORAGE_KEY,
  THEME_MODES,
  applyThemeMode,
  readThemeMode,
  type ThemeStore,
  type ThemeTarget,
} from '../../dashboard/app/theme_mode';

/** Stands in for `document.documentElement`, recording what was set. */
function fakeTarget(): ThemeTarget & {attribute: string | undefined} {
  return {
    attribute: undefined,
    setAttribute(_name: string, value: string): void {
      this.attribute = value;
    },
    removeAttribute(): void {
      this.attribute = undefined;
    },
  };
}

/** Stands in for `localStorage`, optionally as a broken one. */
function fakeStore(
  options: {throwOnGet?: boolean; throwOnSet?: boolean} = {},
): ThemeStore & {entries: Record<string, string>} {
  return {
    entries: {},
    getItem(key: string): string | null {
      if (options.throwOnGet) throw new Error('storage disabled');
      return this.entries[key] ?? null;
    },
    setItem(key: string, value: string): void {
      if (options.throwOnSet) throw new Error('quota exceeded');
      this.entries[key] = value;
    },
  };
}

describe('dashboard theme — remembering a palette', () => {
  it('starts on the default when nothing has been chosen', () => {
    expect(readThemeMode(fakeStore())).toBe(DEFAULT_THEME);
  });

  it('reads back a palette that was chosen', () => {
    const store = fakeStore();
    applyThemeMode('dark', fakeTarget(), store);
    expect(store.entries[STORAGE_KEY]).toBe('dark');
    expect(readThemeMode(store)).toBe('dark');
  });

  it('falls back to the default rather than trusting an unknown stored value', () => {
    // The key lives in a shared origin's storage, so validating it is cheaper
    // than rendering against a palette that does not exist.
    const store = fakeStore();
    store.entries[STORAGE_KEY] = 'solarized';
    expect(readThemeMode(store)).toBe(DEFAULT_THEME);
  });

  it('carries a browser holding a retired palette name onto the default', () => {
    // `light` was the default's name before the palettes were named. The same
    // fallback that rejects nonsense is what makes renaming one safe.
    const store = fakeStore();
    store.entries[STORAGE_KEY] = 'light';
    expect(readThemeMode(store)).toBe(DEFAULT_THEME);
  });

  it('round-trips every palette the picker offers', () => {
    // Guards the pairing this rests on: a name in THEME_MODES with no CSS block
    // would still store and read back, but a name that fails to survive here
    // could never be selected at all.
    for (const mode of THEME_MODES) {
      const store = fakeStore();
      applyThemeMode(mode, fakeTarget(), store);
      expect(readThemeMode(store)).toBe(mode);
    }
  });
});

describe('dashboard theme — applying a palette', () => {
  it('marks the document for any palette other than the default', () => {
    const target = fakeTarget();
    applyThemeMode('dark', target, fakeStore());
    expect(target.attribute).toBe('dark');
  });

  it('clears the mark for the default, so the DOM claims no override', () => {
    const target = fakeTarget();
    const store = fakeStore();
    applyThemeMode('dark', target, store);
    applyThemeMode(DEFAULT_THEME, target, store);
    expect(target.attribute).toBeUndefined();
  });
});

describe('dashboard theme — when storage is unavailable', () => {
  it('still starts, rather than failing over a colour preference', () => {
    expect(readThemeMode(fakeStore({throwOnGet: true}))).toBe(DEFAULT_THEME);
  });

  it('still applies a choice that it cannot remember', () => {
    const target = fakeTarget();
    expect(() => {
      applyThemeMode('dark', target, fakeStore({throwOnSet: true}));
    }).not.toThrow();
    expect(target.attribute).toBe('dark');
  });
});
