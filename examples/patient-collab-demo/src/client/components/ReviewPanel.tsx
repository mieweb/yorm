/**
 * Editor review list (PLAN.md 7c): the open change intents polled from
 * `GET /proposals`, each with the proposed vs. base value, the proposing
 * actor, and Accept / Reject actions. A stale accept (409) surfaces an
 * inline "changed since proposed" state offering Accept anyway / Reject.
 */
import { useState } from "react";
import { Button } from "@mieweb/ui";
import type { ChangeIntent } from "@yorm/yjs";

import { t } from "../i18n";
import { PATIENT_FIELDS, formatFieldValue, samePath } from "../patientFields";
import { useCollabStore } from "../store";
import "./review-panel.scss";

/** The field label for a proposal's path, falling back to the raw path. */
function fieldLabelFor(proposal: ChangeIntent): string {
  const patient = useCollabStore.getState().patient;
  if (patient) {
    for (const spec of PATIENT_FIELDS) {
      const path = spec.proposalPath(patient);
      if (path && samePath(path, proposal.path)) {
        return t(spec.labelKey);
      }
    }
  }
  return JSON.stringify(proposal.path);
}

export function ReviewPanel(): React.JSX.Element | null {
  const role = useCollabStore((state) => state.role);
  const proposals = useCollabStore((state) => state.proposals);
  const resolveProposal = useCollabStore((state) => state.resolveProposal);
  // Stale-accept conflicts by proposal id → current canonical value.
  const [conflicts, setConflicts] = useState<Record<string, unknown>>({});

  if (role !== "editor") {
    return null;
  }
  const open = proposals.filter((proposal) => proposal.status === "proposed");

  const accept = async (id: string): Promise<void> => {
    const result = await resolveProposal(id, "accept");
    if (result.conflict) {
      setConflicts((previous) => ({ ...previous, [id]: result.currentValue }));
    }
  };

  return (
    <section className="review-panel" aria-label={t("review.title")}>
      <h2 className="review-title">{t("review.title")}</h2>
      <p className="review-subtitle">{t("review.subtitle")}</p>
      {open.length === 0 ? (
        <p className="review-empty">{t("review.empty")}</p>
      ) : (
        <ul className="review-list">
          {open.map((proposal) => {
            const field = fieldLabelFor(proposal);
            const conflicted = proposal.id in conflicts;
            return (
              <li key={proposal.id} className="review-item">
                <div className="review-item-summary">
                  <span className="review-field">{field}</span>
                  <span className="review-proposed">
                    {t("review.proposed", { value: formatFieldValue(proposal.proposedValue) })}
                  </span>
                  <span className="review-base">
                    {t("review.base", { value: formatFieldValue(proposal.baseValue) })}
                  </span>
                  <span className="review-actor">
                    {t("review.actor", { actor: proposal.actor })}
                  </span>
                </div>
                {conflicted && (
                  <p className="review-conflict" role="alert">
                    {t("review.conflict", { value: formatFieldValue(conflicts[proposal.id]) })}
                  </p>
                )}
                <div className="review-actions">
                  {conflicted ? (
                    <Button
                      variant="primary"
                      size="sm"
                      aria-label={t("review.acceptAnywayLabel", { field })}
                      onClick={() => void resolveProposal(proposal.id, "accept-anyway")}
                    >
                      {t("review.acceptAnyway")}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      aria-label={t("review.acceptLabel", { field })}
                      onClick={() => void accept(proposal.id)}
                    >
                      {t("review.accept")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("review.rejectLabel", { field })}
                    onClick={() => void resolveProposal(proposal.id, "reject")}
                  >
                    {t("review.reject")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
