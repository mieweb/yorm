/**
 * The dense custom Patient editor — the demo's own (non-eSheet) UI: a
 * compact multi-column grid over the ENTIRE Patient object, generated from
 * `patientEditorFields.ts` specs. Editor inputs write the Y.Doc directly
 * (`setFieldBySpec` → transact); proposer edits become debounced proposals.
 *
 * Per-field extras:
 * - inline suggestion adornment when an open proposal targets the field
 *   (proposed value + actor; editors get Accept / Reject with the 409
 *   "changed since proposed" conflict flow; proposers see a distinct
 *   pending chip) — linked to the input via `aria-describedby`;
 * - a colored presence dot when a peer's awareness `focusedField` matches;
 * - focus/blur feed awareness presence and the `on-blur` projection signal.
 *
 * The trailing "unmapped extras" strip renders everything the editor has no
 * input for as read-only JSON chips — those keys live only in the canonical
 * document ("keep the object").
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@mieweb/ui";
import type { Patient } from "@yorm/fhir";
import type { ChangeIntent } from "@yorm/yjs";

import { t } from "../i18n";
import { buildDenseSections, unmappedExtras } from "../patientEditorFields";
import type { DenseFieldSpec } from "../patientEditorFields";
import { formatFieldValue, samePath } from "../patientFields";
import { useCollabStore } from "../store";
import type { Peer } from "../store";
import { useProposalActions } from "../useProposalActions";
import type { ProposalActions } from "../useProposalActions";
import "./patient-editor.scss";

export function PatientEditor(): React.JSX.Element | null {
  const patient = useCollabStore((state) => state.patient);
  const role = useCollabStore((state) => state.role);
  const peers = useCollabStore((state) => state.peers);
  const proposals = useCollabStore((state) => state.proposals);
  const actions = useProposalActions();

  if (!patient) {
    return null;
  }
  const open = proposals.filter((proposal) => proposal.status === "proposed");
  const extras = unmappedExtras(patient);

  return (
    <div className="patient-editor">
      <p className="patient-editor-hint">
        {role === "proposer" ? t("form.proposerHint") : t("form.subtitle")}
      </p>
      <p className="patient-editor-id">
        <span className="patient-editor-id-label">{t("editor.resourceId")}</span>
        <code>{patient.id ?? ""}</code>
      </p>
      {buildDenseSections(patient).map((section) => (
        <fieldset key={section.id} className="editor-section">
          <legend className="editor-section-legend">{section.label}</legend>
          <div className="editor-section-grid">
            {section.fields.map((spec) => (
              <DenseField
                key={spec.id}
                spec={spec}
                patient={patient}
                openProposals={open}
                peers={peers}
                editorRole={role === "editor"}
                actions={actions}
              />
            ))}
          </div>
        </fieldset>
      ))}
      {extras.length > 0 && (
        <div className="editor-extras">
          <h3 className="editor-extras-title">{t("editor.extras.title")}</h3>
          <p className="editor-extras-hint">{t("editor.extras.hint")}</p>
          <ul className="editor-extras-list" aria-label={t("editor.extras.title")}>
            {extras.map((extra) => (
              <li key={extra.key} className="editor-extra-chip">
                <span className="editor-extra-key">{extra.key}</span>
                <code className="editor-extra-json">{extra.json}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface DenseFieldProps {
  spec: DenseFieldSpec;
  patient: Patient;
  openProposals: ChangeIntent[];
  peers: Peer[];
  editorRole: boolean;
  actions: ProposalActions;
}

function DenseField(props: DenseFieldProps): React.JSX.Element {
  const { spec, patient, openProposals, peers, editorRole, actions } = props;
  // While focused, the local draft wins over the canonical value so typing
  // is never round-tripped through the doc (and proposer keystrokes — which
  // do not change the canonical value — stay visible until blur).
  const [draft, setDraft] = useState<string | null>(null);

  const canonical = spec.read(patient);
  const path = spec.proposalPath(patient);
  const proposal = path
    ? openProposals.filter((candidate) => samePath(candidate.path, path)).at(-1)
    : undefined;
  const inputId = `dense-${spec.id}`;
  const adornmentId = `dense-suggestion-${spec.id}`;
  const editingPeers = peers.filter((peer) => !peer.isLocal && peer.focusedField === spec.id);

  // Suggestion-resolution snap-back: when the field's open suggestion goes
  // away (accepted / rejected / superseded), drop the local draft so the
  // canonical value shows again — a rejected suggestion must not linger in
  // the proposer's input.
  const proposalId = proposal?.id ?? null;
  const lastProposalId = useRef<string | null>(proposalId);
  useEffect(() => {
    if (lastProposalId.current !== null && proposalId === null) {
      setDraft(null);
    }
    lastProposalId.current = proposalId;
  }, [proposalId]);

  const handleFocus = (): void => {
    useCollabStore.getState().setFocusedField(spec.id);
  };
  const handleBlur = (): void => {
    setDraft(null);
    const { setFocusedField, signalBlur } = useCollabStore.getState();
    setFocusedField(null);
    signalBlur();
  };
  const handleChange = (value: string): void => {
    setDraft(value);
    useCollabStore.getState().setFieldBySpec(spec, value);
  };

  const shared = {
    id: inputId,
    onFocus: handleFocus,
    onBlur: handleBlur,
    "aria-describedby": proposal ? adornmentId : undefined,
  };

  return (
    <div className={`dense-field${spec.control === "checkbox" ? " dense-field-inline" : ""}`}>
      <span className="dense-field-head">
        <label className="dense-label" htmlFor={inputId}>
          {spec.label}
        </label>
        {editingPeers.map((peer) => (
          <span
            key={peer.clientId}
            className="dense-peer-dot"
            style={{ backgroundColor: peer.color }}
            role="img"
            aria-label={t("editor.peerEditing", { name: peer.name })}
            title={t("editor.peerEditing", { name: peer.name })}
          >
            {peer.name.slice(0, 1)}
          </span>
        ))}
      </span>
      {spec.control === "select" ? (
        <select
          {...shared}
          className={`dense-input${proposal ? " has-suggestion" : ""}`}
          value={draft ?? canonical}
          onChange={(event) => handleChange(event.target.value)}
        >
          {spec.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : spec.control === "checkbox" ? (
        <input
          {...shared}
          type="checkbox"
          className={`dense-checkbox${proposal ? " has-suggestion" : ""}`}
          checked={canonical === "true"}
          onChange={(event) => handleChange(event.target.checked ? "true" : "false")}
        />
      ) : (
        <input
          {...shared}
          type={spec.control === "date" ? "date" : "text"}
          className={`dense-input${proposal ? " has-suggestion" : ""}`}
          value={draft ?? canonical}
          onChange={(event) => handleChange(event.target.value)}
        />
      )}
      {proposal && (
        <InlineSuggestion
          spec={spec}
          proposal={proposal}
          adornmentId={adornmentId}
          editorRole={editorRole}
          actions={actions}
        />
      )}
    </div>
  );
}

interface InlineSuggestionProps {
  spec: DenseFieldSpec;
  proposal: ChangeIntent;
  adornmentId: string;
  editorRole: boolean;
  actions: ProposalActions;
}

/** The compact suggestion adornment rendered right next to the field. */
function InlineSuggestion(props: InlineSuggestionProps): React.JSX.Element {
  const { spec, proposal, adornmentId, editorRole, actions } = props;
  const conflicted = proposal.id in actions.conflicts;
  return (
    <span
      id={adornmentId}
      className={`dense-suggestion${editorRole ? "" : " dense-suggestion-pending"}`}
    >
      <span className="dense-suggestion-value">
        {t("review.proposed", { value: formatFieldValue(proposal.proposedValue) })}
      </span>
      <span className="dense-suggestion-actor">{t("review.actor", { actor: proposal.actor })}</span>
      {!editorRole && <span className="dense-suggestion-actor">{t("suggestion.pendingHint")}</span>}
      {conflicted && (
        <span className="dense-suggestion-conflict" role="alert">
          {t("review.conflict", { value: formatFieldValue(actions.conflicts[proposal.id]) })}
        </span>
      )}
      {editorRole && (
        <span className="dense-suggestion-actions">
          {conflicted ? (
            <Button
              variant="primary"
              size="sm"
              aria-label={t("review.acceptAnywayLabel", { field: spec.label })}
              onClick={() => void actions.resolve(proposal.id, "accept-anyway")}
            >
              {t("review.acceptAnyway")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              aria-label={t("review.acceptLabel", { field: spec.label })}
              onClick={() => void actions.resolve(proposal.id, "accept")}
            >
              {t("review.accept")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-label={t("review.rejectLabel", { field: spec.label })}
            onClick={() => void actions.resolve(proposal.id, "reject")}
          >
            {t("review.reject")}
          </Button>
        </span>
      )}
    </span>
  );
}
