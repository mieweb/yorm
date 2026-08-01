/**
 * The header's room-status dot (@mieweb/ui `CollabStatus`, compact): a single
 * dot that opens a panel with the room identity, who is in the room, and a
 * rolling activity log.
 *
 * One dot carries both halves of "is my work safe": the transport state and,
 * through `attention`, whether the SQL projection is still behind the
 * document (amber until the policy's trigger commits it).
 *
 * The log merges two sources: the Yjs transport events `useYjsCollabStatus`
 * records (sync, doc updates, peers joining/leaving) and the demo's own
 * `events` slice (local field edits, autosave-policy switches, suggestions,
 * projection commits) — everything that happens to this room, newest first.
 */
import { CollabStatus, useYjsCollabStatus } from "@mieweb/ui";
import type { CollabLogEntry } from "@mieweb/ui";
import { useMemo } from "react";

import { t } from "../i18n";
import { collabDoc, useCollabStore } from "../store";

export function RoomStatus(): React.JSX.Element {
  const provider = useCollabStore((state) => state.provider);
  const selfName = useCollabStore((state) => state.selfName);
  const selfColor = useCollabStore((state) => state.selfColor);
  const events = useCollabStore((state) => state.events);
  const role = useCollabStore((state) => state.role);
  const mode = useCollabStore((state) => state.mode);
  const pending = useCollabStore((state) => state.pendingProjection);

  const status = useYjsCollabStatus({
    doc: collabDoc,
    provider,
    user: { name: selfName, color: selfColor },
    userId: t("collab.user.value", {
      name: selfName,
      role: t(`role.${role}`),
      mode: t(`mode.${mode}`),
    }),
  });

  const log = useMemo(
    (): CollabLogEntry[] => [...events, ...status.log].sort((a, b) => b.at - a.at),
    [events, status.log],
  );

  return (
    <CollabStatus
      {...status}
      log={log}
      compact
      attention={pending ? t("policy.pending") : null}
      labels={{
        live: t("connection.connected"),
        connecting: t("connection.connecting"),
        editing: (names) => t("collab.editing", { names: names.join(", ") }),
        triggerLabel: t("collab.trigger"),
        peersTitle: (count) => t("collab.peersTitle", { count }),
        alone: t("collab.alone"),
        logTitle: (count) => t("collab.logTitle", { count }),
        close: t("collab.close"),
        wrap: t("collab.wrap"),
        empty: t("collab.empty"),
        roomTerm: t("collab.room"),
        urlTerm: t("collab.socket"),
        clientTerm: t("collab.client"),
        userTerm: t("collab.user"),
        clientSynced: t("collab.synced"),
        clientConnecting: t("collab.connecting"),
      }}
    />
  );
}
