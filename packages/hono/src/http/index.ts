/**
 * REST routes of the YORM Hono plugin (PLAN.md M3).
 *
 * All routes are JSON, run `onAuthorize` first (403 on refusal), return 400
 * for malformed bodies and 500 with `{ error }` for everything unexpected.
 * See packages/hono/README.md for the route table.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { DEFAULT_ROOT_KEY, applyJsonPatchLike } from "@yorm/yjs";
import type { DocumentSession, Yorm } from "@yorm/yjs";

import type { HonoYormOptions } from "../index.js";
import type { SessionCache } from "../shared.js";
import { authorize, parsePolicy } from "../shared.js";

/** Client error carrying a 400 response message. */
class BadRequestError extends Error {}

/** One PATCH operation: set `value` at `path`, or remove when `value` is omitted. */
interface PatchOp {
  path: Array<string | number>;
  value?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePatchOp(value: unknown): PatchOp {
  if (!isPlainObject(value)) {
    throw new BadRequestError("each patch operation must be an object with a path array");
  }
  const path = value["path"];
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    !path.every((segment) => typeof segment === "string" || typeof segment === "number")
  ) {
    throw new BadRequestError(
      "patch path must be a non-empty array of string keys and number indices",
    );
  }
  return { path: path as Array<string | number>, value: value["value"] };
}

type SessionHandler = (
  c: Context,
  session: DocumentSession,
  type: string,
  id: string,
) => Promise<Response>;

/**
 * Builds the `/docs/*` sub-app.
 */
export function createHttpRoutes(
  yorm: Yorm,
  sessions: SessionCache,
  options: HonoYormOptions,
): Hono {
  const app = new Hono();

  /** Authorize → open cached session → handler; maps errors to 400/500. */
  const handle =
    (fn: SessionHandler) =>
    async (c: Context): Promise<Response> => {
      const type = c.req.param("type") ?? "";
      const id = c.req.param("id") ?? "";
      if (!(await authorize(c, options, type, id))) {
        return c.json({ error: "forbidden" }, 403);
      }
      try {
        const session = await sessions.get(type, id);
        return await fn(c, session, type, id);
      } catch (error) {
        if (error instanceof BadRequestError) {
          return c.json({ error: error.message }, 400);
        }
        return c.json({ error: errorMessage(error) }, 500);
      }
    };

  app.get(
    "/docs/:type/:id",
    handle(async (c, session, type, id) => {
      // "Not found" (pragmatic v1 definition): the document was never
      // persisted (no stored snapshot) AND no in-memory state exists
      // (version 0) — merely opening a session must not create a document.
      const stored = await yorm.stores.documents.loadDocument(type, id);
      const version = session.projectionState().version;
      if (stored === null && version === 0) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json({ object: session.read(), version });
    }),
  );

  app.put(
    "/docs/:type/:id",
    handle(async (c, session) => {
      const body = await readJsonBody(c);
      if (!isPlainObject(body)) {
        throw new BadRequestError("document body must be a JSON object");
      }
      await session.write(body);
      return c.json({ version: session.projectionState().version });
    }),
  );

  app.patch(
    "/docs/:type/:id",
    handle(async (c, session) => {
      const body = await readJsonBody(c);
      const ops = (Array.isArray(body) ? body : [body]).map(parsePatchOp);
      // v1: one semantic transaction per operation (documented in README).
      // PATCH assumes the JSON codec's default root key.
      for (const op of ops) {
        try {
          applyJsonPatchLike(session.doc, DEFAULT_ROOT_KEY, op.path, op.value);
        } catch (error) {
          throw new BadRequestError(errorMessage(error));
        }
      }
      return c.json({ version: session.projectionState().version });
    }),
  );

  app.get(
    "/docs/:type/:id/projection-state",
    handle(async (c, session, type, id) => {
      const state = session.projectionState();
      const mappings = yorm.mappings.filter((mapping) => mapping.documentType === type);
      const checkpoints = await Promise.all(
        mappings.map(async (mapping) => ({
          mappingName: mapping.name,
          mappingVersion: mapping.version,
          state: await yorm.stores.projections.getState(id, mapping.name),
        })),
      );
      return c.json({ ...state, checkpoints });
    }),
  );

  app.post(
    "/docs/:type/:id/flush",
    handle(async (c, session) => {
      await session.signal("flush");
      const state = session.projectionState();
      return c.json({ version: state.version, pending: state.pending });
    }),
  );

  app.post(
    "/docs/:type/:id/signal",
    handle(async (c, session) => {
      const body = await readJsonBody(c);
      const kind = isPlainObject(body) ? body["kind"] : undefined;
      if (kind !== "blur" && kind !== "flush") {
        throw new BadRequestError('signal kind must be "blur" or "flush"');
      }
      await session.signal(kind);
      const state = session.projectionState();
      return c.json({ version: state.version, pending: state.pending });
    }),
  );

  app.post(
    "/docs/:type/:id/policy",
    handle(async (c, session) => {
      const policy = parsePolicy(await readJsonBody(c));
      if (policy === null) {
        throw new BadRequestError(
          'policy must be { kind: "every-change" | "on-blur" | "idle" | "explicit", ms? }',
        );
      }
      // v1 (same simplification as @yorm/yjs, documented): the policy applies
      // to the shared per-document scheduler, not to one HTTP "session".
      session.setPolicy(policy);
      return c.body(null, 204);
    }),
  );

  return app;
}
