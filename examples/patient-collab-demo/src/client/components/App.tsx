/**
 * UI shell: header with presence, the dense/eSheet view toggle, the
 * role/mode/autosave-policy controls and the room-status dot; below it two
 * faux desktop windows — the "Sample Application" (suggestions bar + Patient
 * editor) and the "Sample Server" debug terminal (live SQLite projection).
 * The terminal is deliberately a separate window: `?pane=server` renders it
 * alone, and the pop-out button opens exactly that in its own browser window
 * so the main screen is just the application.
 */
import React from "react";

import { t } from "../i18n";
import { useCollabStore } from "../store";
import { PatientEditor } from "./PatientEditor";
import { PatientForm } from "./PatientForm";
import { PresenceBar } from "./PresenceBar";
import { ReviewPanel } from "./ReviewPanel";
import { ModeSwitcher } from "./ModeSwitcher";
import { RoleSwitcher } from "./RoleSwitcher";
import { RoomStatus } from "./RoomStatus";
import { PolicyBar } from "./PolicyBar";
import { ServerTerminal } from "./ServerTerminal";
import { ViewToggle } from "./ViewToggle";
import { WindowFrame } from "./WindowFrame";
import "./app-shell.scss";

const REPO_URL = "https://github.com/mieweb/yorm";
const DOCS_URL = `${REPO_URL}/tree/main/examples/patient-collab-demo#readme`;

/** `?pane=server` — this page is only the server debug terminal. */
const SERVER_PANE = new URLSearchParams(location.search).get("pane") === "server";

export function App(): React.JSX.Element {
  const view = useCollabStore((state) => state.view);
  const announcement = useCollabStore((state) => state.announcement);
  const [serverWindow, setServerWindow] = React.useState<Window | null>(null);

  // Closing the popped-out terminal by hand must bring the pane back.
  React.useEffect(() => {
    if (!serverWindow) return;
    const timer = setInterval(() => {
      if (serverWindow.closed) setServerWindow(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [serverWindow]);

  const popOutServer = (): void => {
    const win = window.open("?pane=server", "yorm-server-terminal", "width=880,height=1000");
    if (win) setServerWindow(win);
  };

  if (SERVER_PANE) {
    return (
      <div className="app-shell app-shell--server-pane">
        <ServerTerminal />
        <div className="live-announcer" role="status" aria-live="polite">
          {announcement}
        </div>
      </div>
    );
  }

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
          <a
            className="app-repo-link"
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("app.docs")}
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
      <main className={serverWindow ? "app-main app-main--solo" : "app-main"}>
        <WindowFrame title={t("app.sample")} label={t("app.sample")}>
          <ReviewPanel />
          {view === "dense" ? <PatientEditor /> : <PatientForm />}
        </WindowFrame>
        {serverWindow ? (
          <p className="server-popped-note">
            {t("server.poppedOut")}{" "}
            <button
              type="button"
              className="server-popped-focus"
              onClick={() => serverWindow.focus()}
            >
              {t("server.focus")}
            </button>
          </p>
        ) : (
          <ServerTerminal onPopOut={popOutServer} />
        )}
      </main>
      <div className="live-announcer" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
