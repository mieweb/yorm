/**
 * UI shell (PLAN.md 6c): header with presence + connection status, the
 * policy bar + eSheet Patient form on the left, the live SQLite projection
 * panel on the right, and a polite live region announcing presence and row
 * updates to assistive technologies.
 */
import { Badge } from "@mieweb/ui";

import { t } from "../i18n";
import { useCollabStore } from "../store";
import type { ConnectionStatus } from "../store";
import { PatientForm } from "./PatientForm";
import { PolicyBar } from "./PolicyBar";
import { PresenceBar } from "./PresenceBar";
import { ProjectionPanel } from "./ProjectionPanel";
import "./app-shell.scss";

const STATUS_VARIANT: Record<ConnectionStatus, "success" | "warning" | "danger"> = {
  connected: "success",
  connecting: "warning",
  disconnected: "danger",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: t("connection.connected"),
  connecting: t("connection.connecting"),
  disconnected: t("connection.disconnected"),
};

export function App(): React.JSX.Element {
  const status = useCollabStore((state) => state.status);
  const announcement = useCollabStore((state) => state.announcement);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-heading">
          <h1 className="app-title">{t("app.title")}</h1>
          <p className="app-subtitle">{t("app.subtitle")}</p>
        </div>
        <div className="app-status">
          <PresenceBar />
          <Badge variant={STATUS_VARIANT[status]} aria-label={t("connection.label")}>
            {STATUS_LABEL[status]}
          </Badge>
        </div>
      </header>
      <main className="app-main">
        <section className="editor-pane" aria-label={t("form.title")}>
          <PolicyBar />
          <PatientForm />
        </section>
        <ProjectionPanel />
      </main>
      <div className="live-announcer" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
