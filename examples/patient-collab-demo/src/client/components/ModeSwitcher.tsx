/**
 * Mode switcher (PLAN.md 7c): editor mode writes the canonical document
 * directly; proposer edits become change intents on the proposals subtree.
 * Switching reconnects the WebSocket with `?mode=` so the server enforces
 * the mode.
 */
import { Select } from "@mieweb/ui";

import type { DemoMode } from "../api";
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./mode-switcher.scss";

const MODE_OPTIONS: Array<{ value: DemoMode; label: string }> = [
  { value: "editor", label: t("mode.editor") },
  { value: "proposer", label: t("mode.proposer") },
];

export function ModeSwitcher(): React.JSX.Element {
  const mode = useCollabStore((state) => state.mode);
  const setMode = useCollabStore((state) => state.setMode);

  return (
    <div className="mode-switcher">
      <Select
        id="mode-select"
        label={t("mode.label")}
        options={MODE_OPTIONS}
        value={mode}
        onValueChange={(value) => setMode(value as DemoMode)}
        size="sm"
      />
    </div>
  );
}
