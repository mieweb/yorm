# @yorm/hono

Hono adapter for [@yorm/server](../server/README.md):
`app.route("/yorm", createHonoYorm(yorm))` turns any Hono app into a YORM
server. **Routes, WebSocket protocol, query params and options are documented
in [@yorm/server](../server/README.md)** — this README covers only what is
Hono-specific.

## Mounting (Node)

Hono's `upgradeWebSocket` is runtime-specific (Node/Bun/Deno/Cloudflare), so
the adapter takes it via injection instead of locking in a runtime. On Node:

```ts
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { createHonoYorm } from "@yorm/hono";

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.route(
  "/yorm",
  createHonoYorm(yorm, {
    upgradeWebSocket, // mounts GET /yorm/ws/:type/:id
    onAuthorize: (request, { type, id }) => checkToken(request.header("authorization"), type, id),
    defaultPolicy: { kind: "idle", ms: 30_000 },
    maxLagMs: 120_000,
  }),
);

const server = serve({ fetch: app.fetch, port: 3000 });
injectWebSocket(server);
```

Without `options.upgradeWebSocket`, `createHonoYorm` mounts the HTTP routes
only; mount the WebSocket route separately with:

```ts
app.route("/yorm", createHonoYormWebSocket(yorm, upgradeWebSocket, options));
```

> `createHonoYormWebSocket` builds its **own** session cache. Use the single
> `createHonoYorm(yorm, { upgradeWebSocket })` call unless you have a reason to
> serve the two halves from separate apps.

## Options

```ts
interface HonoYormOptions extends YormServerOptions {
  upgradeWebSocket?: UpgradeWebSocket; // lets createHonoYorm mount /ws itself
}
```

Everything inherited from `YormServerOptions` (`onAuthorize`,
`onAuthorizeWrite`, `onValidateSyncUpdate`, `rolePolicies`, `defaultPolicy`,
`maxLagMs`) is described in [@yorm/server → Options](../server/README.md#options).
The hooks receive a neutral `YormRequest`, not a Hono `Context`, so authorization
code ports unchanged to the Fastify and Express adapters.
