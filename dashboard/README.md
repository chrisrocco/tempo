# tempo dashboard

A read-and-control UI for a running tempo server: what is running, what is
broken, and why.

It is a **separate package**. It talks to the server over the same RPC the CLI
uses, and the engine has no idea it exists — there is no flag on `tempo up` that
starts it, and nothing in the engine that serves it. Start it yourself and point
it at a server.

## Running it

Build once, then start:

```
npm run build -w @tempo/dashboard
```

```
npm start -w @tempo/dashboard
```

It prints the URL it bound. Three environment variables configure it:

| variable     | default                 | what it is                      |
| ------------ | ----------------------- | ------------------------------- |
| `ENGINE_URL` | `http://127.0.0.1:7233` | the tempo server's RPC endpoint |
| `PORT`       | `0` (any free port)     | what the dashboard listens on   |
| `HOST`       | `127.0.0.1`             | the interface it binds          |

So against a server on another port:

```
ENGINE_URL=http://127.0.0.1:7400 PORT=3000 npm start -w @tempo/dashboard
```

## Working on it

Run the build in watch mode in one terminal and the server in another:

```
npm run watch -w @tempo/dashboard
```

Edit a file, and it rebuilds in tens of milliseconds; reload the browser to pick
it up.

Two terminals rather than one because **the server never builds anything**, even
in development. A server that rebuilt on demand would be a code path that only
ever runs locally — and the one a build system would never take, so it would
drift from the one that matters.

Note that `npm run build` strips types without checking them. `npm run typecheck`
at the repo root is still what actually checks the code, and it covers this
package under two configs: one for the browser half and one for the server half,
kept apart so neither sees the other's globals.

## Before you expose it

**Neither transport has any authentication.** The dashboard can cancel and
terminate executions, and anything that can reach it can do the same. It binds
loopback by default for that reason, and the proxy in front of the engine adds a
hop rather than a control — it is not a security boundary.

Keep both on a trusted network.

## How it is put together

Two halves, in `app/` and `server/`.

`app/` is the browser code: Lit, bundled by esbuild into `dist/`. It imports the
engine's projection types and predicates directly, which is what makes a field
added to a projection a compile error here rather than `undefined` at runtime.

The bundle is built `--format=iife` because `app/index.html` loads it as a
classic script. That pairing is not free-standing — the comment at the top of
`index.html` says why the shell cannot use `type="module"` and what breaks if the
two drift apart, and `tools/conventions.ts` fails the lint if they do.

`server/` serves `dist/` and forwards the page's RPC calls to the engine. The
forwarding is why the browser only ever talks to one origin, and why the engine
needed no CORS support added to it. It reads files and proxies; there is nothing
else in it.

Each module says what it is and why; start with `server/main.ts` for the process
and `app/app.ts` for the shell.
