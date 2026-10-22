/**
 * The framework-neutral surface every YORM transport adapter implements.
 *
 * Two abstractions carry everything the server needs: {@link YormRequest} for
 * HTTP (and the WebSocket upgrade), and {@link YormSocket} for a live
 * connection. Keeping them this small is what lets `@yorm/hono`,
 * `@yorm/fastify`, and `@yorm/express` be thin wrappers rather than forks.
 */
import type { ProjectionTriggerPolicy, RolePolicy } from "@yorm/yjs";
import type * as Y from "yjs";

/** Which subtree of the document a write targets (PLAN.md M7). */
export type WriteScope = "canonical" | "proposals";

/** The document a request addresses. */
export interface DocRef {
  type: string;
  id: string;
}

/**
 * The slice of an incoming HTTP request (or WebSocket upgrade) the server
 * uses. `rawBody` is part of the contract from day one so webhook signature
 * verification can be added without a breaking change (YOTA-plan.md Y4a).
 */
export interface YormRequest {
  readonly method: string;
  readonly path: string;
  /** Path parameter, e.g. `:type` in `/docs/:type/:id`. */
  param(name: string): string | undefined;
  query(name: string): string | undefined;
  header(name: string): string | undefined;
  /** Parsed JSON body. Rejects when the body is absent or malformed. */
  json(): Promise<unknown>;
  /** Unparsed request body, for signature verification. */
  rawBody(): Promise<Uint8Array>;
}

/**
 * A JSON response. `body === undefined` means an empty body (204).
 */
export interface YormResponse {
  status: number;
  body?: unknown;
}

export type HttpMethod = "GET" | "PUT" | "PATCH" | "POST" | "DELETE";

/**
 * One route, described declaratively so each adapter only has to register it
 * with its own router. Paths use the colon syntax Hono, Express, and Fastify
 * all understand.
 */
export interface YormRoute {
  method: HttpMethod;
  path: string;
  handle(request: YormRequest): Promise<YormResponse>;
}

/**
 * One live WebSocket connection. Adapters must pass the **same object** for
 * every event of a connection: room fan-out skips the origin socket by
 * reference identity.
 */
export interface YormSocket {
  send(data: Uint8Array): void;
  close(code: number, reason?: string): void;
}

/** Connection lifecycle callbacks the adapter drives. */
export interface YormSocketHandlers {
  onOpen(socket: YormSocket): void;
  /** Binary frames only — the Yjs wire protocol is binary. */
  onMessage(socket: YormSocket, data: Uint8Array): void;
  onClose(socket: YormSocket): void;
}

/**
 * The collaboration endpoint. `connect` runs the authorization hooks and
 * resolves the room **before** the socket opens; an unauthorized upgrade
 * still yields handlers, whose `onOpen` closes the socket with 1008 (the
 * frameworks differ too much to refuse the upgrade itself uniformly).
 */
export interface YormWebSocketEndpoint {
  path: string;
  connect(request: YormRequest): Promise<YormSocketHandlers>;
}

export interface YormServerOptions {
  /**
   * Synchronous pre-apply guard for raw canonical WebSocket updates, including
   * initial SyncStep2 uploads. `after` is a disposable scratch document; never
   * mutate `before`. False refuses the entire update and closes with 1008.
   * Lens writes use their role policy; HTTP writes use codecs/authorization.
   */
  onValidateSyncUpdate?: (
    request: YormRequest,
    docRef: DocRef,
    before: Y.Doc,
    after: Y.Doc,
  ) => boolean;
  /**
   * Authorization hook, run before every HTTP route and WebSocket upgrade.
   * Returning `false` yields 403 on HTTP and close code 1008 on WebSocket.
   */
  onAuthorize?: (request: YormRequest, docRef: DocRef) => boolean | Promise<boolean>;
  /**
   * Per-subtree write authorization (PLAN.md M7): run in addition to
   * `onAuthorize` before any write. Scope is `"canonical"` for PUT/PATCH and
   * proposal resolution (accepting writes canonical state), `"proposals"`
   * for creating/withdrawing proposals. On WebSocket connections the scope
   * is chosen by the `?mode=proposer` query param: proposer connections need
   * `"proposals"` write access and have direct canonical edits refused (see
   * `guardCanonicalWrites`); all other connections need `"canonical"`.
   * Absent hook means allow. Returning `false` yields 403 / close 1008.
   */
  onAuthorizeWrite?: (
    request: YormRequest,
    docRef: DocRef,
    scope: WriteScope,
  ) => boolean | Promise<boolean>;
  /**
   * Role policies (role-security POC): when a WebSocket connection's
   * `?role=` matches a policy for the document type, the connection syncs a
   * server-held **policy lens** — a derived doc holding only the role's
   * `view` — instead of the canonical doc, and every incoming update is
   * validated by the policy's `canWrite` (violations close the socket with
   * 1008). Roles without a policy are untouched. **POC caveat:** the HTTP
   * routes are not policy-aware yet — deny REST access for lens roles via
   * `onAuthorize`/`onAuthorizeWrite`.
   */
  rolePolicies?: RolePolicy[];
  /**
   * Projection trigger policy applied when the server opens a document
   * session. Defaults to the Yorm instance's own default (passthrough).
   */
  defaultPolicy?: ProjectionTriggerPolicy;
  /**
   * Server-level safety cap: at most this many ms may pass between a
   * persisted change and a forced projection flush, so deferred policies
   * (`explicit`, `on-blur`) cannot lag forever.
   */
  maxLagMs?: number;
}
