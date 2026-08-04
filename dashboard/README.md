# tempo dashboard

A read-and-control UI for a running tempo server: what is running, what is
broken, and why.

It is a **separate package**. It talks to the server over the same RPC the CLI
uses, and the engine has no idea it exists — there is no flag on `tempo up` that
starts it, and nothing in the engine that serves it. Start it yourself and point
it at a server.

## Running it

```
npm start -w @tempo/dashboard
```

It prints the URL it bound. Three environment variables configure it:

| variable     | default                 | what it is                       |
| ------------ | ----------------------- | -------------------------------- |
| `ENGINE_URL` | `http://127.0.0.1:7233` | the tempo server's RPC endpoint   |
| `PORT`       | `0` (any free port)     | what the dashboard listens on     |
| `HOST`       | `127.0.0.1`             | the interface it binds            |

So against a server on another port:

```
ENGINE_URL=http://127.0.0.1:7400 PORT=3000 npm start -w @tempo/dashboard
```

## Before you expose it

**Neither transport has any authentication.** The dashboard can cancel and
terminate executions, and anything that can reach it can do the same. It binds
loopback by default for that reason, and the proxy in front of the engine adds a
hop rather than a control — it is not a security boundary.

Keep both on a trusted network.

## How it is put together

Two halves, in `app/` and `server/`.

`app/` is the browser code: Lit, no build step, no bundler. The server transpiles
TypeScript on request and generates an import map, which is what stands in for
one.

`server/` hands that code to the browser and forwards the page's RPC calls to the
engine. The forwarding is why the browser only ever talks to one origin, and why
the engine needed no CORS support added to it.

Each module says what it is and why; start with `server/main.ts` for the process
and `app/app.ts` for the shell.
