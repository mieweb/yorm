/**
 * Header view toggle: which Patient editor the left pane renders — the
 * demo's dense custom editor (default) or the eSheet-rendered form. Both
 * views share the same store, proposals, and top bar; the initial view can
 * also come from the URL (`?view=esheet`).
 */
import { Tabs, TabsList, TabsTrigger } from "@mieweb/ui";

import { t } from "../i18n";
import { useCollabStore } from "../store";
import type { ViewKind } from "../store";
import "./view-toggle.scss";

export function ViewToggle(): React.JSX.Element {
  const view = useCollabStore((state) => state.view);
  const setView = useCollabStore((state) => state.setView);

  return (
    <div className="view-toggle">
      <span className="view-toggle-label" aria-hidden="true">
        {t("view.label")}
      </span>
      <Tabs value={view} onValueChange={(value) => setView(value as ViewKind)} variant="pills">
        <TabsList aria-label={t("view.label")}>
          <TabsTrigger value="dense">{t("view.dense")}</TabsTrigger>
          <TabsTrigger value="esheet">{t("view.esheet")}</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
