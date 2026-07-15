/**
 * REST routes of the YORM Hono plugin (PLAN.md M3).
 *
 * All routes are JSON, run `onAuthorize` first (403 on refusal), return 400
 * for malformed bodies and 500 with `{ error }` for everything unexpected.
 * See packages/hono/README.md for the route table.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  DEFAULT_ROOT_KEY,
  ProposalNotFoundError,
  ProposalStateError,
  applyJsonPatchLike,
} from "@yorm/yjs";
import type { DocumentSession, ProposalOp, ProposalStatus, Yorm } from "@yorm/yjs";

import type { HonoYormOptions, WriteScope } from "../index.js";
import type { SessionCache } from "../shared.js";
import { authorize, authorizeWrite, parsePolicy } from "../shared.js";

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

const PROPOSAL_OPS = ["set", "insert", "remove"] as const;
const PROPOSAL_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;

/** Validates a POST /proposals body. */
function parseProposeBody(value: unknown): {
  path: Array<string | number>;
  op: ProposalOp;
  proposedValue?: unknown;
  actor: string;
} {
  if (!isPlainObject(value)) {
    throw new BadRequestError("proposal body must be a JSON object");
  }
  const { path } = parsePatchOp({ path: value["path"] });
  const op = value["op"];
  if (typeof op !== "string" || !(PROPOSAL_OPS as readonly string[]).includes(op)) {
    throw new BadRequestError('proposal op must be "set", "insert", or "remove"');
  }
  const actor = value["actor"];
  if (typeof actor !== "string" || actor.length === 0) {
    throw new BadRequestError("proposal actor must be a non-empty string");
  }
  if (op !== "remove" && value["proposedValue"] === undefined) {
    throw new BadRequestError(`proposal op "${op}" requires a proposedValue`);
  }
  return {
    path,
    op: op as ProposalOp,
    ...(value["proposedValue"] !== undefined ? { proposedValue: value["proposedValue"] } : {}),
    actor,
  };
}

/** `resolvedBy` from an optional JSON body, defaulting to `"unknown"`. */
async function resolvedByFrom(c: Context): Promise<string> {
  const body: unknown = await c.req.json().catch(() => undefined);
  const resolvedBy = isPlainObject(body) ? body["resolvedBy"] : undefined;
  return typeof resolvedBy === "string" && resolvedBy.length > 0 ? resolvedBy : "unknown";
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

  /**
   * Authorize (plus per-subtree write authorization when `writeScope` is
   * given) → open cached session → handler; maps errors to 400/404/409/500.
   */
  const handle =
    (fn: SessionHandler, writeScope?: WriteScope) =>
    async (c: Context): Promise<Response> => {
      const type = c.req.param("type") ?? "";
      const id = c.req.param("id") ?? "";
      if (!(await authorize(c, options, type, id))) {
        return c.json({ error: "forbidden" }, 403);
      }
      if (writeScope !== undefined && !(await authorizeWrite(c, options, type, id, writeScope))) {
        return c.json({ error: "forbidden" }, 403);
      }
      try {
        const session = await sessions.get(type, id);
        return await fn(c, session, type, id);
      } catch (error) {
        if (error instanceof BadRequestError) {
          return c.json({ error: error.message }, 400);
        }
        if (error instanceof ProposalNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        if (error instanceof ProposalStateError) {
          return c.json({ error: error.message }, 409);
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
    }, "canonical"),
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
    }, "canonical"),
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

  // --- Proposed changes (PLAN.md M7) -------------------------------------

  app.get(
    "/docs/:type/:id/proposals",
    handle(async (c, session) => {
      const status = c.req.query("status");
      if (status !== undefined && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestError(
          'status filter must be "proposed", "accepted", "rejected", or "superseded"',
        );
      }
      const filter = status !== undefined ? { status: status as ProposalStatus } : undefined;
      return c.json({ proposals: session.proposals().list(filter) });
    }),
  );

  app.post(
    "/docs/:type/:id/proposals",
    handle(async (c, session) => {
      const input = parseProposeBody(await readJsonBody(c));
      const proposal = session.proposals().propose(input);
      return c.json({ proposal }, 201);
    }, "proposals"),
  );

  // Accepting writes canonical state, so accept routes need "canonical".
  app.post(
    "/docs/:type/:id/proposals/:pid/accept",
    handle(async (c, session) => {
      const pid = c.req.param("pid") ?? "";
      const result = session.proposals().accept(pid, await resolvedByFrom(c));
      if (result.conflict) {
        return c.json({ conflict: true, currentValue: result.currentValue ?? null }, 409);
      }
      return c.json({ conflict: false, version: session.projectionState().version });
    }, "canonical"),
  );

  app.post(
    "/docs/:type/:id/proposals/:pid/accept-anyway",
    handle(async (c, session) => {
      const pid = c.req.param("pid") ?? "";
      session.proposals().acceptAnyway(pid, await resolvedByFrom(c));
      return c.json({ conflict: false, version: session.projectionState().version });
    }, "canonical"),
  );

  app.post(
    "/docs/:type/:id/proposals/:pid/reject",
    handle(async (c, session) => {
      const pid = c.req.param("pid") ?? "";
      session.proposals().reject(pid, await resolvedByFrom(c));
      return c.json({ ok: true });
    }, "canonical"),
  );

  app.delete(
    "/docs/:type/:id/proposals/:pid",
    handle(async (c, session) => {
      session.proposals().withdraw(c.req.param("pid") ?? "");
      return c.body(null, 204);
    }, "proposals"),
  );

  // Deleting resolved history rewrites the shared subtree for everyone, so
  // it needs the "canonical" write scope (an editor/moderator action).
  app.post(
    "/docs/:type/:id/proposals/clear-resolved",
    handle(async (c, session) => {
      const cleared = session.proposals().clearResolved();
      return c.json({ cleared });
    }, "canonical"),
  );

  return app;
}
