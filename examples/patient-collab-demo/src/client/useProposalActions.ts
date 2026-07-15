/**
 * Shared proposal-resolution state (top bar + inline adornments): wraps the
 * store's `resolveProposal` with the per-surface 409-conflict bookkeeping —
 * a stale accept records the current canonical value so the UI can offer
 * "Accept anyway" — plus the sequential mass-resolve used by the top bar's
 * "Accept all" / "Reject all" buttons.
 */
import { useCallback, useState } from "react";

import { useCollabStore } from "./store";

export type ResolveAction = "accept" | "accept-anyway" | "reject";

export interface ProposalActions {
  /** Stale-accept conflicts by proposal id → current canonical value. */
  conflicts: Record<string, unknown>;
  /** True while a mass resolve is running (disables the mass buttons). */
  massRunning: boolean;
  resolve(id: string, action: ResolveAction): Promise<void>;
  /** Resolves sequentially; conflicted accepts stay open with inline state. */
  resolveAll(ids: readonly string[], action: "accept" | "reject"): Promise<void>;
}

export function useProposalActions(): ProposalActions {
  const resolveProposal = useCollabStore((state) => state.resolveProposal);
  const [conflicts, setConflicts] = useState<Record<string, unknown>>({});
  const [massRunning, setMassRunning] = useState(false);

  const resolve = useCallback(
    async (id: string, action: ResolveAction): Promise<void> => {
      const result = await resolveProposal(id, action);
      if (result.conflict) {
        setConflicts((previous) => ({ ...previous, [id]: result.currentValue }));
      }
    },
    [resolveProposal],
  );

  const resolveAll = useCallback(
    async (ids: readonly string[], action: "accept" | "reject"): Promise<void> => {
      setMassRunning(true);
      try {
        for (const id of ids) {
          await resolve(id, action);
        }
      } finally {
        setMassRunning(false);
      }
    },
    [resolve],
  );

  return { conflicts, massRunning, resolve, resolveAll };
}
