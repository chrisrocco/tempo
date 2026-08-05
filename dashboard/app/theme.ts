/**
 * @fileoverview
 * The dashboard's shared visual vocabulary — the element styles that appear in
 * more than one component.
 *
 * Shadow DOM is why this is a module rather than a stylesheet. Styles do not
 * cross a shadow boundary, so every component that renders a table or a badge
 * needs its own copy of those rules; without a shared source they get copied by
 * hand and drift, which is how two views end up disagreeing about what "failed"
 * looks like. Each component composes what it needs:
 * `static styles = [surface, table, css\`…\`]`.
 *
 * ## The palette is not here
 *
 * The colors live on `:root` in `index.html`, and everything below refers to
 * them by name. Custom properties are the one thing that crosses a shadow
 * boundary, so a single declaration at the document root reaches every
 * component.
 *
 * They used to be declared on `:host` in `surface`, which reached every
 * component too — but a property set directly on `:host` beats the same property
 * inherited from an ancestor, so the palette could not be overridden from
 * outside. That made a theme switch impossible without touching all thirteen
 * components. Moving one declaration up is what `theme_mode.ts` swaps.
 *
 * Every rule here names a role (`--danger`, not a red), so a component asking
 * for "the color of something broken" does not have to know which one that
 * currently is — or which palette is loaded.
 */

import {css} from 'lit';

/**
 * The base treatment every component starts from. Include first.
 *
 * `color` is restated rather than left to inherit because a shadow root's host
 * does not inherit it from the document in every case a component is used
 * standalone, and restating it costs nothing.
 */
export const surface = css`
  :host {
    display: block;
    color: var(--text);
  }

  a {
    color: var(--accent);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
`;

/** The section heading used above every panel and view. */
export const heading = css`
  h1,
  h2 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 18px;
  }
  h2 {
    font-size: 12px;
    margin: 0 0 10px;
  }
`;

/** The listing table, shared by the executions list and the history timeline. */
export const table = css`
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th {
    text-align: left;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 0 14px 8px 0;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: 9px 14px 9px 0;
    border-bottom: 1px solid var(--border-soft);
    font-variant-numeric: tabular-nums;
    vertical-align: top;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12.5px;
  }
`;

/**
 * Status pills.
 *
 * `stuck` is in the same set as the four statuses even though it is not one —
 * it is a derived predicate (`isStuck`) — because to a reader scanning a column
 * it occupies exactly the same slot, and giving it a different shape would hide
 * the thing most worth noticing.
 */
export const badge = css`
  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }
  .running {
    background: var(--accent-bg);
    color: var(--accent);
  }
  .completed {
    background: var(--ok-bg);
    color: var(--ok);
  }
  .failed {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .terminated {
    background: var(--neutral-bg);
    color: var(--neutral);
  }
  .stuck {
    background: var(--warn-bg);
    color: var(--warn);
  }
`;

/** Buttons and text inputs, for the filter bar and the action bar. */
export const controls = css`
  button,
  input,
  select {
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 10px;
  }
  button {
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--dim);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  input::placeholder {
    color: var(--dim);
  }
  .danger {
    color: var(--danger);
    border-color: var(--danger-bg);
  }
`;

/** A bordered card — the detail view's building block. */
export const panel = css`
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    margin: 0 0 16px;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
`;

/**
 * How long ago, in the shortest form that is still honest.
 *
 * Returns `undefined` for a missing timestamp rather than a formatted zero:
 * history written before `ts` existed has none, and rendering that as "56 years
 * ago" would be a lie the reader has no way to detect.
 */
export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '—';
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** An absolute timestamp, for the title attribute behind a relative one. */
export function absoluteTime(ts: number | undefined): string {
  return ts === undefined
    ? 'no timestamp recorded'
    : new Date(ts).toISOString();
}
