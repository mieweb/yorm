/**
 * Policy-lens role switcher (role-security POC): physician (full canonical
 * access), nurse and receptionist (server-side redacted view + write rules,
 * see src/rolePolicies.ts). Switching navigates to `?role=` — a lens role
 * syncs a *different* server document (the derived, redacted Y.Doc), so the
 * page reloads with a fresh client doc instead of reconnecting in place.
 */
import { Select } from "@mieweb/ui";

import { DEMO_ROLES } from "../../rolePolicies";
import type { DemoRole } from "../../rolePolicies";
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./role-switcher.scss";

const ROLE_OPTIONS: Array<{ value: DemoRole; label: string }> = DEMO_ROLES.map((role) => ({
  value: role,
  label: t(`role.${role}`),
}));

export function RoleSwitcher(): React.JSX.Element {
  const role = useCollabStore((state) => state.role);

  return (
    <div className="role-switcher">
      <Select
        id="role-select"
        label={t("role.label")}
        options={ROLE_OPTIONS}
        value={role}
        onValueChange={(value) => {
          const url = new URL(location.href);
          url.searchParams.set("role", value);
          location.assign(url);
        }}
        size="sm"
      />
    </div>
  );
}
