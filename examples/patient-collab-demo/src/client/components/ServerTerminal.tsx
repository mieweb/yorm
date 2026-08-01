/**
 * The Sample Server debug terminal: a dark faux-terminal window around the
 * live SQLite projection panel. Deliberately NOT part of the sample
 * application — it is what a DBA tailing the server's database would see,
 * and it can pop out into its own browser window to make that separation
 * physical.
 */
import { t } from "../i18n";
import { ProjectionPanel } from "./ProjectionPanel";
import { UnmappedExtras } from "./UnmappedExtras";
import { WindowFrame } from "./WindowFrame";
import "./server-terminal.scss";

export function ServerTerminal({ onPopOut }: { onPopOut?: () => void }): React.JSX.Element {
  return (
    <WindowFrame
      title={t("server.window")}
      label={t("server.window")}
      className="server-terminal"
      actions={
        onPopOut && (
          <button
            type="button"
            className="server-terminal-popout"
            onClick={onPopOut}
            aria-label={t("server.popOut")}
            title={t("server.popOut")}
          >
            {t("server.popOut.short")} ↗
          </button>
        )
      }
    >
      <p className="server-terminal-note">
        {t("server.note")}
        {onPopOut && <> {t("server.note.popHint")}</>}
      </p>
      <ProjectionPanel />
      <UnmappedExtras />
    </WindowFrame>
  );
}
