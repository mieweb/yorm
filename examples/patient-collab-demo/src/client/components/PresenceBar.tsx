/**
 * Presence avatars driven by Yjs awareness: one avatar per connected client,
 * ringed in the peer's presence color, with the focused field (if any) in
 * the accessible label.
 */
import { Avatar } from "@mieweb/ui";

import { t } from "../i18n";
import { getFieldSpec } from "../patientFields";
import { useCollabStore } from "../store";
import type { Peer } from "../store";
import "./presence-bar.scss";

function peerLabel(peer: Peer): string {
  const name = peer.isLocal ? t("presence.you", { name: peer.name }) : peer.name;
  if (peer.focusedField) {
    const spec = getFieldSpec(peer.focusedField);
    const field = spec ? t(spec.labelKey) : peer.focusedField;
    return t("presence.editingField", { name, field });
  }
  return t("presence.idle", { name });
}

export function PresenceBar(): React.JSX.Element {
  const peers = useCollabStore((state) => state.peers);

  return (
    <ul className="presence-bar" aria-label={t("presence.label")}>
      {peers.map((peer) => (
        <li key={peer.clientId} className="presence-peer" title={peerLabel(peer)}>
          <Avatar
            size="sm"
            ring
            name={peer.name}
            aria-label={peerLabel(peer)}
            style={{ boxShadow: `0 0 0 2px ${peer.color}` }}
          />
        </li>
      ))}
    </ul>
  );
}
