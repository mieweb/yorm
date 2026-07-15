/**
 * Projection trigger policy scheduler (PLAN.md decision #10).
 *
 * Yjs updates always persist immediately; the SQL projection commit is gated
 * by a policy. The scheduler coalesces document versions and projects the
 * latest state exactly once per trigger.
 */

/** When projection commits happen relative to document changes. */
export type ProjectionTriggerPolicy =
  | { kind: "every-change" }
  | { kind: "on-blur" }
  | { kind: "idle"; ms?: number }
  | { kind: "explicit" };

/** Default debounce for the `idle` policy. */
export const DEFAULT_IDLE_MS = 30_000;

export interface ProjectionSchedulerOptions {
  /** Server default policy. Defaults to `every-change`. */
  defaultPolicy?: ProjectionTriggerPolicy;
  /**
   * Safety flush cap: if this many ms elapse since the oldest unprojected
   * change, a projection is forced. Applies to `on-blur` / `idle` /
   * `explicit` (under `every-change` nothing can lag).
   */
  maxLagMs?: number;
  /** Projects the latest document state once, coalesced. */
  onProject: (latestVersion: number) => Promise<void>;
}

/**
 * Coalesces document changes and triggers projection per policy.
 *
 * Runs are serialized on an internal promise queue: while a projection is in
 * flight, further changes coalesce into at most one trailing run. On
 * `onProject` rejection the pending range is kept and {@link lastError} is
 * set; the next trigger retries.
 */
export class ProjectionScheduler {
  private policy: ProjectionTriggerPolicy;
  private readonly onProject: (latestVersion: number) => Promise<void>;
  private readonly maxLagMs: number | undefined;
  private pending: { from: number; to: number } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lagTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private _lastError: string | undefined;

  constructor(options: ProjectionSchedulerOptions) {
    this.policy = options.defaultPolicy ?? { kind: "every-change" };
    this.onProject = options.onProject;
    this.maxLagMs = options.maxLagMs;
  }

  /** Message of the most recent failed projection run, cleared on success. */
  get lastError(): string | undefined {
    return this._lastError;
  }

  /** Records that a persisted document change produced `documentVersion`. */
  notifyChange(documentVersion: number): void {
    if (this.disposed) {
      return;
    }
    if (this.pending === null) {
      this.pending = { from: documentVersion, to: documentVersion };
      this.startLagTimer();
    } else {
      this.pending.to = Math.max(this.pending.to, documentVersion);
    }
    switch (this.policy.kind) {
      case "every-change":
        void this.scheduleRun();
        break;
      case "idle":
        this.restartIdleTimer(this.policy.ms ?? DEFAULT_IDLE_MS);
        break;
      case "on-blur":
      case "explicit":
        // Wait for signal() (or the max-lag cap).
        break;
    }
  }

  /**
   * `blur` triggers projection under the `on-blur` policy; `flush` (explicit
   * save) always projects if anything is pending. Resolves when the resulting
   * projection run (if any) has settled.
   */
  async signal(kind: "blur" | "flush"): Promise<void> {
    if (kind === "flush" || this.policy.kind === "on-blur") {
      await this.scheduleRun();
    }
  }

  /** Switches the trigger policy for this session. */
  setPolicy(p: ProjectionTriggerPolicy): void {
    this.policy = p;
    this.clearIdleTimer();
    if (this.pending !== null) {
      if (p.kind === "every-change") {
        void this.scheduleRun();
      } else if (p.kind === "idle") {
        this.restartIdleTimer(p.ms ?? DEFAULT_IDLE_MS);
      }
    }
  }

  /** The unprojected document version range, or `null` when caught up. */
  pendingVersions(): { from: number; to: number } | null {
    return this.pending === null ? null : { ...this.pending };
  }

  /** Awaits any queued/in-flight projection runs without triggering one. */
  settle(): Promise<void> {
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.clearLagTimer();
  }

  /** Enqueues one run after any in-flight run; never rejects. */
  private scheduleRun(): Promise<void> {
    const run = this.queue.then(() => this.runOnce());
    this.queue = run;
    return run;
  }

  private async runOnce(): Promise<void> {
    if (this.disposed || this.pending === null) {
      return;
    }
    const to = this.pending.to;
    this.clearIdleTimer();
    this.clearLagTimer();
    try {
      await this.onProject(to);
      this._lastError = undefined;
      if (this.pending !== null) {
        this.pending = this.pending.to <= to ? null : { from: to + 1, to: this.pending.to };
      }
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
    }
    if (this.pending !== null) {
      this.startLagTimer();
    }
  }

  private restartIdleTimer(ms: number): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.scheduleRun();
    }, ms);
  }

  private startLagTimer(): void {
    if (this.maxLagMs === undefined || this.policy.kind === "every-change") {
      return;
    }
    if (this.lagTimer !== null) {
      return;
    }
    this.lagTimer = setTimeout(() => {
      this.lagTimer = null;
      void this.scheduleRun();
    }, this.maxLagMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearLagTimer(): void {
    if (this.lagTimer !== null) {
      clearTimeout(this.lagTimer);
      this.lagTimer = null;
    }
  }
}
