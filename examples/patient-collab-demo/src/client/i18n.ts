/**
 * All user-facing strings live here (I18N: no hardcoded UI literals in
 * components). `t(key, vars)` does a simple `{var}` interpolation over the
 * English defaults; additional locales would add sibling dictionaries.
 */
const en = {
  "app.title": "YORM Patient Collab Demo",
  "app.subtitle": "Two browsers, one FHIR Patient — the SQL rows are projections",
  "connection.label": "Connection",
  "connection.connecting": "Connecting…",
  "connection.connected": "Connected",
  "connection.disconnected": "Disconnected",
  "presence.label": "Editing now",
  "presence.you": "{name} (you)",
  "presence.editingField": "{name} — editing {field}",
  "presence.idle": "{name}",
  "presence.userName": "User {n}",
  "policy.label": "Autosave policy",
  "policy.every-change": "Every change",
  "policy.on-blur": "On blur",
  "policy.idle": "Idle (30 s)",
  "policy.explicit": "Explicit (Save button)",
  "policy.save": "Save",
  "policy.pending": "Unsaved projection changes",
  "policy.saved": "Projection up to date",
  "form.title": "FHIR Patient",
  "form.subtitle": "Edits sync live over Yjs; SQL commits follow the autosave policy",
  "form.given": "Given names",
  "form.family": "Family name",
  "form.birthDate": "Birth date",
  "form.phone": "Phone",
  "form.email": "Email",
  "rows.title": "SQLite projection rows",
  "rows.subtitle": "Written by the projection engine from the canonical document — never by the UI",
  "rows.empty": "No rows",
  "announce.rowsUpdated": "Projection rows updated",
  "announce.peerJoined": "A collaborator joined",
  "announce.peerLeft": "A collaborator left",
} as const;

export type StringKey = keyof typeof en;

/** Looks up a UI string, interpolating `{var}` placeholders. */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let text: string = en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
