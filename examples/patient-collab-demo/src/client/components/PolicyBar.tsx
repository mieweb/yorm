/**
 * Autosave policy control (PLAN.md 6c / Decision #10): a header select that
 * sets the session's projection trigger policy, plus a Save button under
 * `explicit`. The resulting projection state shows in the app status badge.
 */
import { Button, Select } from "@mieweb/ui";

import type { PolicyKind } from "../api";
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./policy-bar.scss";

const POLICY_OPTIONS: Array<{ value: PolicyKind; label: string }> = [
  { value: "every-change", label: t("policy.every-change") },
  { value: "on-blur", label: t("policy.on-blur") },
  { value: "idle", label: t("policy.idle") },
  { value: "explicit", label: t("policy.explicit") },
];

export function PolicyBar(): React.JSX.Element {
  const policy = useCollabStore((state) => state.policy);
  const selectPolicy = useCollabStore((state) => state.selectPolicy);
  const save = useCollabStore((state) => state.save);

  return (
    <div className="policy-bar">
      <div className="policy-picker">
        <Select
          id="policy-select"
          label={t("policy.label")}
          options={POLICY_OPTIONS}
          value={policy}
          onValueChange={(value) => selectPolicy(value as PolicyKind)}
          size="sm"
        />
      </div>
      {policy === "explicit" && (
        <Button variant="primary" size="sm" onClick={save} aria-label={t("policy.save")}>
          {t("policy.save")}
        </Button>
      )}
    </div>
  );
}
