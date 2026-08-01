/**
 * Everything the editor has no input for, as read-only JSON chips — those
 * keys live only in the canonical document ("keep the object"), which is why
 * this sits under the projection panel: it is the counterpart to the rows.
 */
import { t } from "../i18n";
import { unmappedExtras } from "../patientEditorFields";
import { useCollabStore } from "../store";
import "./unmapped-extras.scss";

export function UnmappedExtras(): React.JSX.Element | null {
  const patient = useCollabStore((state) => state.patient);
  const extras = patient ? unmappedExtras(patient) : [];
  if (extras.length === 0) {
    return null;
  }

  return (
    <section className="unmapped-extras" aria-label={t("editor.extras.title")}>
      <h2 className="unmapped-extras-title">{t("editor.extras.title")}</h2>
      <p className="unmapped-extras-hint">{t("editor.extras.hint")}</p>
      <ul className="unmapped-extras-list">
        {extras.map((extra) => (
          <li key={extra.key} className="unmapped-extra-chip">
            <span className="unmapped-extra-key">{extra.key}</span>
            <code className="unmapped-extra-json">{extra.json}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
