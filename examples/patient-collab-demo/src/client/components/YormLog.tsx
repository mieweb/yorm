/**
 * Tail of what YORM triggered since this page loaded — projection commits,
 * policy switches, suggestions — filtered from the room-status event slice
 * (local UI edits are app-side noise, not engine triggers).
 */
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./yorm-log.scss";

export function YormLog(): React.JSX.Element {
  const events = useCollabStore((state) => state.events);
  const triggered = events.filter((entry) => entry.origin !== "local");
  return (
    <section className="yorm-log" aria-label={t("server.log")}>
      <h3 className="yorm-log-title">{t("server.log")}</h3>
      {triggered.length === 0 ? (
        <p className="yorm-log-empty">{t("server.log.empty")}</p>
      ) : (
        <ol className="yorm-log-entries">
          {triggered.map((entry) => (
            <li key={entry.id} className="yorm-log-entry">
              <time className="yorm-log-time" dateTime={new Date(entry.at).toISOString()}>
                {new Date(entry.at).toLocaleTimeString()}
              </time>
              <span className="yorm-log-detail">{entry.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
