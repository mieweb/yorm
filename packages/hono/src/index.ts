/**
 * @yorm/hono — pluggable Hono server component (PLAN.md Milestone 3,
 * deliverable 1): `app.route("/yorm", createHonoYorm(yorm))` turns any Hono
 * app into a YORM server.
 *
 * The plugin only sees `Yorm` interfaces — it has no dependency on any DB
 * package. See packages/hono/README.md for routes, options, and examples.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { ProjectionTriggerPolicy, Yorm } from "@yorm/yjs";

import { createHttpRoutes } from "./http/index.js";
import { createSessionCache } from "./shared.js";
import { createWebSocketRoutes } from "./websocket/index.js";

export { guardCanonicalWrites } from "./websocket/index.js";

export const YORM_HONO_VERSION = "0.1.0";

/** Which subtree of the document a write targets (PLAN.md M7). */
export type WriteScope = "canonical" | "proposals";

export interface HonoYormOptions {
  /**
   * Authorization hook, run before every HTTP route and WebSocket upgrade.
   * Returning `false` yields 403 on HTTP and close code 1008 on WebSocket.
   */
  onAuthorize?: (ctx: Context, docRef: { type: string; id: string }) => boolean | Promise<boolean>;
  /**
   * Per-subtree write authorization (PLAN.md M7): run in addition to
   * `onAuthorize` before any write. Scope is `"canonical"` for PUT/PATCH and
   * proposal resolution (accepting writes canonical state), `"proposals"`
   * for creating/withdrawing proposals. On WebSocket connections the scope
   * is chosen by the `?role=proposer` query param: proposer connections need
   * `"proposals"` write access and have direct canonical edits refused (see
   * `guardCanonicalWrites`); all other connections need `"canonical"`.
   * Absent hook means allow. Returning `false` yields 403 / close 1008.
   */
  onAuthorizeWrite?: (
    ctx: Context,
    docRef: { type: string; id: string },
    scope: WriteScope,
  ) => boolean | Promise<boolean>;
  /**
   * Projection trigger policy applied when the plugin opens a document
   * session. Defaults to the Yorm instance's own default (passthrough).
   */
  defaultPolicy?: ProjectionTriggerPolicy;
  /**
   * Plugin-level safety cap: at most this many ms may pass between a
   * persisted change and a forced projection flush, so deferred policies
   * (`explicit`, `on-blur`) cannot lag forever.
   */
  maxLagMs?: number;
  /**
   * Runtime-specific WebSocket upgrader (e.g. `createNodeWebSocket(...)`
   * from `@hono/node-ws`, or Bun/Deno/Cloudflare equivalents). When
   * provided, {@link createHonoYorm} mounts `GET /ws/:type/:id` itself;
   * otherwise use {@link createHonoYormWebSocket} to mount it separately.
   */
  upgradeWebSocket?: UpgradeWebSocket;
}

/**
 * Creates the mountable YORM sub-app: the REST routes under `/docs/*`, plus
 * the WebSocket route under `/ws/*` when `options.upgradeWebSocket` is given.
 */
export function createHonoYorm(yorm: Yorm, options: HonoYormOptions = {}): Hono {
  const sessions = createSessionCache(yorm, options);
  const app = new Hono();
  app.route("/", createHttpRoutes(yorm, sessions, options));
  if (options.upgradeWebSocket) {
    app.route("/", createWebSocketRoutes(options.upgradeWebSocket, sessions, options));
  }
  return app;
}

/**
 * Creates a sub-app containing only `GET /ws/:type/:id` (y-protocols sync +
 * awareness). The upgrader is injected because Hono's `upgradeWebSocket` is
 * runtime-specific — this keeps the plugin free of runtime lock-in.
 */
export function createHonoYormWebSocket(
  yorm: Yorm,
  upgradeWebSocket: UpgradeWebSocket,
  options: HonoYormOptions = {},
): Hono {
  const sessions = createSessionCache(yorm, options);
  return createWebSocketRoutes(upgradeWebSocket, sessions, options);
}
