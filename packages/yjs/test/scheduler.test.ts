import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectionScheduler, type ProjectionSchedulerOptions } from "../src/index.js";

/** Scheduler wired to a call log; onProject can be blocked or made to fail. */
function makeScheduler(options: Partial<ProjectionSchedulerOptions> = {}) {
  const calls: number[] = [];
  let failWith: Error | null = null;
  let gate: Promise<void> | null = null;
  const scheduler = new ProjectionScheduler({
    ...options,
    onProject: async (latestVersion) => {
      if (gate) {
        const wait = gate;
        gate = null;
        await wait;
      }
      if (failWith) {
        const error = failWith;
        failWith = null;
        throw error;
      }
      calls.push(latestVersion);
    },
  });
  return {
    scheduler,
    calls,
    failNextWith: (error: Error) => {
      failWith = error;
    },
    blockNextRun: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectionScheduler", () => {
  it("every-change projects each change with its version", async () => {
    const { scheduler, calls } = makeScheduler();
    scheduler.notifyChange(1);
    await scheduler.settle();
    scheduler.notifyChange(2);
    await scheduler.settle();
    expect(calls).toEqual([1, 2]);
    expect(scheduler.pendingVersions()).toBeNull();
  });

  it("every-change coalesces changes during an in-flight run into one trailing run", async () => {
    const { scheduler, calls, blockNextRun } = makeScheduler();
    const release = blockNextRun();
    scheduler.notifyChange(1);
    await Promise.resolve(); // let the first run start and capture version 1
    scheduler.notifyChange(2);
    scheduler.notifyChange(3);
    release();
    await scheduler.settle();
    expect(calls).toEqual([1, 3]);
    expect(scheduler.pendingVersions()).toBeNull();
  });

  it("idle: a burst of changes produces exactly one projection with the latest version", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = makeScheduler({ defaultPolicy: { kind: "idle", ms: 1000 } });
    scheduler.notifyChange(1);
    scheduler.notifyChange(2);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.notifyChange(3); // resets the debounce
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([3]);
    expect(scheduler.pendingVersions()).toBeNull();
  });

  it("explicit: projects only on signal('flush'), not on blur or time", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = makeScheduler({ defaultPolicy: { kind: "explicit" } });
    scheduler.notifyChange(1);
    scheduler.notifyChange(2);
    await vi.advanceTimersByTimeAsync(120_000);
    await scheduler.signal("blur");
    expect(calls).toEqual([]);
    await scheduler.signal("flush");
    expect(calls).toEqual([2]);
  });

  it("on-blur: projects on the blur signal only", async () => {
    const { scheduler, calls } = makeScheduler({ defaultPolicy: { kind: "on-blur" } });
    scheduler.notifyChange(1);
    scheduler.notifyChange(2);
    await scheduler.settle();
    expect(calls).toEqual([]);
    await scheduler.signal("blur");
    expect(calls).toEqual([2]);
    await scheduler.signal("blur"); // nothing pending — no extra projection
    expect(calls).toEqual([2]);
  });

  it("max-lag cap forces a projection under explicit", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = makeScheduler({
      defaultPolicy: { kind: "explicit" },
      maxLagMs: 5000,
    });
    scheduler.notifyChange(1);
    await vi.advanceTimersByTimeAsync(4999);
    scheduler.notifyChange(2); // lag timer counts from the oldest unprojected change
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([2]);
    expect(scheduler.pendingVersions()).toBeNull();
  });

  it("pendingVersions reports the coalesced range before flush and null after", async () => {
    const { scheduler } = makeScheduler({ defaultPolicy: { kind: "explicit" } });
    expect(scheduler.pendingVersions()).toBeNull();
    scheduler.notifyChange(3);
    scheduler.notifyChange(4);
    scheduler.notifyChange(7);
    expect(scheduler.pendingVersions()).toEqual({ from: 3, to: 7 });
    await scheduler.signal("flush");
    expect(scheduler.pendingVersions()).toBeNull();
  });

  it("keeps pending state and exposes lastError on rejection; next flush retries", async () => {
    const { scheduler, calls, failNextWith } = makeScheduler({
      defaultPolicy: { kind: "explicit" },
    });
    scheduler.notifyChange(1);
    failNextWith(new Error("boom"));
    await scheduler.signal("flush");
    expect(scheduler.lastError).toBe("boom");
    expect(scheduler.pendingVersions()).toEqual({ from: 1, to: 1 });
    expect(calls).toEqual([]);
    await scheduler.signal("flush");
    expect(calls).toEqual([1]);
    expect(scheduler.lastError).toBeUndefined();
    expect(scheduler.pendingVersions()).toBeNull();
  });

  it("setPolicy to every-change flushes pending changes", async () => {
    const { scheduler, calls } = makeScheduler({ defaultPolicy: { kind: "explicit" } });
    scheduler.notifyChange(1);
    scheduler.setPolicy({ kind: "every-change" });
    await scheduler.settle();
    expect(calls).toEqual([1]);
  });

  it("dispose cancels timers and ignores further changes", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = makeScheduler({ defaultPolicy: { kind: "idle", ms: 100 } });
    scheduler.notifyChange(1);
    scheduler.dispose();
    scheduler.notifyChange(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
  });
});
