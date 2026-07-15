/**
 * Top accumulating proposals bar (M7c, reworked): every change intent of the
 * session — open ones first (with per-item Accept / Reject for editors and
 * the 409 "changed since proposed" conflict flow), then resolved ones greyed
 * out with their status. Collapsible via <details> (default open) with an
 * open-count badge; the list is height-capped so accumulation never reflows
 * the page. Editors also get sequential mass actions: Accept all / Reject
 * all (conflicted accepts stay listed with their inline conflict state).
 */
import { useState } from "react";
import { Badge, Button } from "@mieweb/ui";
import type { ChangeIntent } from "@yorm/yjs";
import type { Patient } from "@yorm/fhir";

import { t } from "../i18n";
import type { StringKey } from "../i18n";
import { denseLabelForPath } from "../patientEditorFields";
import { formatFieldValue } from "../patientFields";
import { useCollabStore } from "../store";
import { useProposalActions } from "../useProposalActions";
import type { ProposalActions } from "../useProposalActions";
import "./review-panel.scss";

/** The field label for a proposal's path, falling back to the raw path. */
function fieldLabelFor(patient: Patient | null, proposal: ChangeIntent): string {
  return (patient && denseLabelForPath(patient, proposal.path)) ?? JSON.stringify(proposal.path);
}

export function ReviewPanel(): React.JSX.Element {
  const role = useCollabStore((state) => state.role);
  const patient = useCollabStore((state) => state.patient);
  const proposals = useCollabStore((state) => state.proposals);
  const actions = useProposalActions();
  const [expanded, setExpanded] = useState(true);
  // Resolved history is hidden by default: the badge counts OPEN suggestions,
  // and showing dozens of resolved intents under a "0 open" badge reads as a
  // contradiction. The toggle keeps the full audit trail one click away.
  const [showResolved, setShowResolved] = useState(false);

  const isEditor = role === "editor";
  const open = proposals.filter((proposal) => proposal.status === "proposed");
  // Open first (oldest → newest), then resolved (newest resolution first).
  const resolved = proposals.filter((proposal) => proposal.status !== "proposed").reverse();
  const listed = showResolved ? [...open, ...resolved] : open;

  return (
    <section className="review-panel" aria-label={t("review.title")}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="review-summary">
          <h2 className="review-title">{t("review.title")}</h2>
          <Badge variant={open.length > 0 ? "warning" : "success"}>
            {t("review.openCount", { count: open.length })}
          </Badge>
        </summary>
        <p className="review-subtitle">{t("review.subtitle")}</p>
        {isEditor && (
          <div className="review-mass-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={actions.massRunning || open.length === 0}
              aria-label={t("review.acceptAllLabel")}
              onClick={() =>
                void actions.resolveAll(
                  open.map((proposal) => proposal.id),
                  "accept",
                )
              }
            >
              {t("review.acceptAll")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={actions.massRunning || open.length === 0}
              aria-label={t("review.rejectAllLabel")}
              onClick={() =>
                void actions.resolveAll(
                  open.map((proposal) => proposal.id),
                  "reject",
                )
              }
            >
              {t("review.rejectAll")}
            </Button>
          </div>
        )}
        {resolved.length > 0 && (
          <button
            type="button"
            className="review-resolved-toggle"
            aria-expanded={showResolved}
            aria-label={t(showResolved ? "review.hideResolvedLabel" : "review.showResolvedLabel")}
            onClick={() => setShowResolved((previous) => !previous)}
          >
            {showResolved
              ? t("review.hideResolved", { count: resolved.length })
              : t("review.showResolved", { count: resolved.length })}
          </button>
        )}
        {listed.length === 0 ? (
          <p className="review-empty">{t("review.empty")}</p>
        ) : (
          <ul className="review-list">
            {listed.map((proposal) => (
              <ReviewItem
                key={proposal.id}
                proposal={proposal}
                patient={patient}
                isEditor={isEditor}
                actions={actions}
              />
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

interface ReviewItemProps {
  proposal: ChangeIntent;
  patient: Patient | null;
  isEditor: boolean;
  actions: ProposalActions;
}

function ReviewItem({ proposal, patient, isEditor, actions }: ReviewItemProps): React.JSX.Element {
  const field = fieldLabelFor(patient, proposal);
  const isOpen = proposal.status === "proposed";
  const conflicted = proposal.id in actions.conflicts;
  return (
    <li className={`review-item${isOpen ? "" : " review-item-resolved"}`}>
      <div className="review-item-summary">
        <span className="review-field">{field}</span>
        <span className="review-proposed">
          {t("review.proposed", { value: formatFieldValue(proposal.proposedValue) })}
        </span>
        <span className="review-base">
          {t("review.base", { value: formatFieldValue(proposal.baseValue) })}
        </span>
        <span className="review-actor">{t("review.actor", { actor: proposal.actor })}</span>
        {!isOpen && (
          <span className="review-status">
            {t(`review.status.${proposal.status}` as StringKey)}
            {proposal.resolvedBy
              ? ` — ${t("review.resolvedBy", { actor: proposal.resolvedBy })}`
              : ""}
          </span>
        )}
      </div>
      {isOpen && conflicted && (
        <p className="review-conflict" role="alert">
          {t("review.conflict", { value: formatFieldValue(actions.conflicts[proposal.id]) })}
        </p>
      )}
      {isOpen && isEditor && (
        <div className="review-actions">
          {conflicted ? (
            <Button
              variant="primary"
              size="sm"
              aria-label={t("review.acceptAnywayLabel", { field })}
              onClick={() => void actions.resolve(proposal.id, "accept-anyway")}
            >
              {t("review.acceptAnyway")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              aria-label={t("review.acceptLabel", { field })}
              onClick={() => void actions.resolve(proposal.id, "accept")}
            >
              {t("review.accept")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-label={t("review.rejectLabel", { field })}
            onClick={() => void actions.resolve(proposal.id, "reject")}
          >
            {t("review.reject")}
          </Button>
        </div>
      )}
    </li>
  );
}
