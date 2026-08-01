/**
 * The Sample Server debug terminal: a dark faux-terminal window around the
 * live SQLite projection panel. Deliberately NOT part of the sample
 * application — it is what a DBA tailing the server's database would see,
 * and it can pop out into its own browser window to make that separation
 * physical.
 */
import { useState } from "react";

import { t } from "../i18n";
import { ProjectionPanel } from "./ProjectionPanel";
import { UnmappedExtras } from "./UnmappedExtras";
import { WindowFrame } from "./WindowFrame";
import { YormLog } from "./YormLog";
import "./server-terminal.scss";

export function ServerTerminal({ onPopOut }: { onPopOut?: () => void }): React.JSX.Element {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <WindowFrame
      title={t("server.window")}
      label={t("server.window")}
      className="server-terminal"
      actions={
        <>
          <button
            type="button"
            className="server-terminal-action server-terminal-info"
            onClick={() => setShowInfo((open) => !open)}
            aria-expanded={showInfo}
            aria-label={t("server.info")}
            title={t("server.info")}
          >
            i
          </button>
          {onPopOut && (
            <button
              type="button"
              className="server-terminal-action"
              onClick={onPopOut}
              aria-label={t("server.popOut")}
              title={t("server.popOut")}
            >
              {t("server.popOut.short")} ↗
            </button>
          )}
        </>
      }
    >
      {showInfo && (
        <p className="server-terminal-note" role="note">
          {t("server.note")}
          {onPopOut && <> {t("server.note.popHint")}</>}
        </p>
      )}
      <ProjectionPanel />
      <UnmappedExtras />
      <YormLog />
    </WindowFrame>
  );
}
