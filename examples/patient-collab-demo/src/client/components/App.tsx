/**
 * UI shell (PLAN.md 6c): header with presence, the dense/eSheet view toggle,
 * the role/mode/autosave-policy controls and the room-status dot; below it a
 * "Sample Application" window frame holding the suggestions bar and the
 * Patient editor, the sample server's live SQLite projection panel on the
 * right, and a polite live region announcing presence and row updates to
 * assistive technologies.
 */
import { t } from "../i18n";
import { useCollabStore } from "../store";
import { PatientEditor } from "./PatientEditor";
import { PatientForm } from "./PatientForm";
import { PolicyBar } from "./PolicyBar";
import { PresenceBar } from "./PresenceBar";
import { ProjectionPanel } from "./ProjectionPanel";
import { ReviewPanel } from "./ReviewPanel";
import { ModeSwitcher } from "./ModeSwitcher";
import { RoleSwitcher } from "./RoleSwitcher";
import { RoomStatus } from "./RoomStatus";
import { UnmappedExtras } from "./UnmappedExtras";
import { ViewToggle } from "./ViewToggle";
import "./app-shell.scss";

const REPO_URL = "https://github.com/mieweb/yorm";

export function App(): React.JSX.Element {
  const view = useCollabStore((state) => state.view);
  const announcement = useCollabStore((state) => state.announcement);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-heading">
          <h1 className="app-title">{t("app.title")}</h1>
          <p className="app-subtitle">{t("app.subtitle")}</p>
          <a
            className="app-repo-link"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("app.repo")}
          </a>
        </div>
        <div className="app-status">
          <PresenceBar />
          <ViewToggle />
          <RoleSwitcher />
          <ModeSwitcher />
          <PolicyBar />
          <RoomStatus />
        </div>
      </header>
      <main className="app-main">
        <section className="sample-app" aria-label={t("app.sample")}>
          <div className="sample-app-chrome">
            <span className="sample-app-dots" aria-hidden="true">
              <span className="sample-app-dot" />
              <span className="sample-app-dot" />
              <span className="sample-app-dot" />
            </span>
            <h2 className="sample-app-title">{t("app.sample")}</h2>
          </div>
          <div className="sample-app-body">
            <ReviewPanel />
            {view === "dense" ? <PatientEditor /> : <PatientForm />}
          </div>
        </section>
        <div className="projection-pane">
          <ProjectionPanel />
          <UnmappedExtras />
        </div>
      </main>
      <div className="live-announcer" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
