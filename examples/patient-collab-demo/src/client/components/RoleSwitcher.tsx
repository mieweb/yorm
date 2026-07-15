/**
 * Role switcher (PLAN.md 7c): editor writes the canonical document directly;
 * proposer edits become change intents on the proposals subtree. Switching
 * reconnects the WebSocket with `?role=` so the server enforces the role.
 */
import { Select } from "@mieweb/ui";

import type { DemoRole } from "../api";
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./role-switcher.scss";

const ROLE_OPTIONS: Array<{ value: DemoRole; label: string }> = [
  { value: "editor", label: t("role.editor") },
  { value: "proposer", label: t("role.proposer") },
];

export function RoleSwitcher(): React.JSX.Element {
  const role = useCollabStore((state) => state.role);
  const setRole = useCollabStore((state) => state.setRole);

  return (
    <div className="role-switcher">
      <Select
        id="role-select"
        label={t("role.label")}
        options={ROLE_OPTIONS}
        value={role}
        onValueChange={(value) => setRole(value as DemoRole)}
        size="sm"
      />
    </div>
  );
}
