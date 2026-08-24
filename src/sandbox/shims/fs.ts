/**
 * `node:fs` and `node:path`, for a browser: present enough to import, loud if
 * anyone actually calls them.
 *
 * Nothing in a sandbox touches a disk. The only file-backed thing in the engine
 * is `FileHistoryStore`, and the sandbox never constructs one —
 * `createServerHost(undefined, …)` keeps everything in memory, which is the
 * whole point of a fixture that dies with its tab. It arrives here anyway
 * because the store is re-exported from `src/server/index.ts`, and importing a
 * barrel imports all of it.
 *
 * So these exist to satisfy the module graph rather than to work. Every member
 * throws, because a browser sandbox silently half-writing a history would be a
 * far worse outcome than a stack trace saying the file store was reached.
 */
const unreachable = (name: string) => (): never => {
  throw new Error(
    `${name} is not available in the browser sandbox — nothing here should touch a disk`,
  );
};

/** The `promises` half, which is the shape `file_history_store` destructures. */
export const promises = {
  mkdir: unreachable('fs.mkdir'),
  rm: unreachable('fs.rm'),
  readFile: unreachable('fs.readFile'),
  writeFile: unreachable('fs.writeFile'),
  appendFile: unreachable('fs.appendFile'),
  rename: unreachable('fs.rename'),
  readdir: unreachable('fs.readdir'),
  stat: unreachable('fs.stat'),
  open: unreachable('fs.open'),
};

export default {promises};
