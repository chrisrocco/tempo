/**
 * @fileoverview
 * Which palette is showing, and remembering it across reloads.
 *
 * The whole mechanism is one attribute on `<html>`: `index.html` declares the
 * default palette on `:root` and each of the others under a
 * `:root[data-theme='…']` selector, so setting or clearing that attribute swaps
 * every color in the app. Nothing else participates — no component reads this
 * module, and none of them know a theme exists. That is the property worth
 * protecting: another palette is a block of CSS and one more entry in
 * `THEME_MODES`, not a change to any view.
 *
 * ## The element and the storage are arguments
 *
 * Neither `document` nor `localStorage` is touched directly; both arrive as
 * narrow interfaces, and `app.ts` supplies the real ones. Same reason
 * `collectHistory` takes a reader instead of the client: it keeps this module
 * DOM-free, which is what lets the suite cover it
 * (`spec/dashboard/theme_mode.spec.ts`) — and the root `tsconfig.json` has no
 * DOM lib, so a spec importing a module that named `document` would not compile.
 *
 * The cases worth covering are the failures, and they are unreachable from a
 * browser without disabling storage.
 *
 * ## Why it is stored at all
 *
 * A picker that forgets is worse than no picker: the reader re-chooses on every
 * reload, which is exactly often enough to be irritating. There is nowhere
 * server-side to put it — the dashboard has no user record, and the engine has
 * never heard of the dashboard (see AGENTS.md) — so the browser is the only
 * place it can live.
 *
 * Both directions are guarded. `localStorage` *throws* rather than returning
 * null when storage is disabled or a private-mode quota is exhausted, and a
 * dashboard that failed to paint because it could not remember a color would be
 * trading the whole page for a detail.
 */

/**
 * The palettes `index.html` declares, in the order the picker offers them.
 *
 * Adding one is an entry here and a block of CSS. Nothing else — no component
 * reads this module, and every rule in `theme.ts` names a role rather than a
 * colour, so a new palette reaches the whole app without any view knowing.
 */
export const THEME_MODES = ['aurora', 'sage', 'sunset', 'dark'] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

/**
 * Aurora is the default, and is what `:root` declares with no attribute set.
 *
 * Renaming the default is safe: an unrecognized stored value falls back here,
 * so a browser still holding the old `light` lands on the palette that name
 * used to mean.
 */
export const DEFAULT_THEME: ThemeMode = 'aurora';

/** Where the choice is kept. Namespaced, since the origin may be shared. */
export const STORAGE_KEY = 'tempo.theme';

/** The part of an element this needs — `document.documentElement`, in practice. */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The part of `localStorage` this needs. Both members may throw. */
export interface ThemeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * The stored choice, or the default.
 *
 * An unrecognized value falls back rather than being applied: the key sits in a
 * shared origin's storage, and validating is cheaper than rendering against a
 * palette that does not exist.
 */
export function readThemeMode(store: ThemeStore): ThemeMode {
  let stored: string | null = null;
  try {
    stored = store.getItem(STORAGE_KEY);
  } catch {
    // Storage disabled. The default is still a working dashboard.
  }
  return isThemeMode(stored) ? stored : DEFAULT_THEME;
}

/**
 * Show `mode`, and remember it.
 *
 * The default clears the attribute rather than setting `data-theme="light"`, so
 * the DOM says "nothing overridden" when nothing is.
 */
export function applyThemeMode(
  mode: ThemeMode,
  target: ThemeTarget,
  store: ThemeStore,
): void {
  if (mode === DEFAULT_THEME) target.removeAttribute('data-theme');
  else target.setAttribute('data-theme', mode);

  try {
    store.setItem(STORAGE_KEY, mode);
  } catch {
    // A choice that cannot be persisted still applies for this session.
  }
}
