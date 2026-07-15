/**
 * The eSheet-rendered FHIR Patient form (PLAN.md 6b + 7c), wired both ways
 * to the Yjs-backed Zustand store:
 *
 * - Yjs → eSheet: whenever the materialized Patient changes, differing field
 *   responses are pushed into the renderer's form store;
 * - eSheet → Yjs: a form-store subscription writes changed answers into the
 *   Y.Doc (echo-safe: a value is only written when it actually differs). In
 *   proposer mode the store turns these writes into proposals instead.
 *
 * Pending suggestions (M7c) render as chips under the form and as a
 * suggestion outline on the affected inputs (linked via `aria-describedby`);
 * the store's aria-live region announces proposal changes. When a proposer's
 * suggestion is resolved, the field snaps back to the canonical value.
 *
 * Focus/blur are captured on the wrapper to feed awareness presence and the
 * `on-blur` projection signal. eSheet field inputs carry ids ending in
 * `-answer-<fieldId>`, which is how the focused field is identified.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormDefinition, FormStore } from "@esheet/core";
import { EsheetRenderer } from "@esheet/renderer";
import type { EsheetRendererHandle } from "@esheet/renderer";
import type { Patient } from "@yorm/fhir";
import type { ChangeIntent } from "@yorm/yjs";

import { t } from "../i18n";
import { PATIENT_FIELDS, formatFieldValue, samePath } from "../patientFields";
import type { PatientFieldSpec } from "../patientFields";
import { useCollabStore } from "../store";
import "./patient-form.scss";

const PATIENT_FORM: FormDefinition = {
  id: "patient-demo-form",
  title: t("form.title"),
  fields: PATIENT_FIELDS.map((spec) => ({
    fieldType: "text",
    id: spec.id,
    question: t(spec.labelKey),
    inputType: spec.inputType,
  })),
};

/** eSheet input ids end in `-answer-<fieldId>`. */
function fieldIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement) || target.id === "") {
    return null;
  }
  const match = /-answer-(.+)$/.exec(target.id);
  return match?.[1] ?? null;
}

/** The latest open proposal per form field, matched by proposal path. */
interface FieldSuggestion {
  spec: PatientFieldSpec;
  proposal: ChangeIntent;
}

function fieldSuggestions(patient: Patient | null, proposals: ChangeIntent[]): FieldSuggestion[] {
  if (!patient) {
    return [];
  }
  const open = proposals.filter((proposal) => proposal.status === "proposed");
  const suggestions: FieldSuggestion[] = [];
  for (const spec of PATIENT_FIELDS) {
    const path = spec.proposalPath(patient);
    if (!path) {
      continue;
    }
    const proposal = open.filter((candidate) => samePath(candidate.path, path)).at(-1);
    if (proposal) {
      suggestions.push({ spec, proposal });
    }
  }
  return suggestions;
}

/** Waits for the first synced Patient, then mounts the form once. */
export function PatientForm(): React.JSX.Element | null {
  const patient = useCollabStore((state) => state.patient);
  if (!patient) {
    return null;
  }
  return <SyncedPatientForm initialPatient={patient} />;
}

function SyncedPatientForm({ initialPatient }: { initialPatient: Patient }): React.JSX.Element {
  const rendererRef = useRef<EsheetRendererHandle>(null);
  const [formStore, setFormStore] = useState<FormStore | null>(null);
  const role = useCollabStore((state) => state.role);
  const patient = useCollabStore((state) => state.patient);
  const proposals = useCollabStore((state) => state.proposals);

  const suggestions = useMemo(() => fieldSuggestions(patient, proposals), [patient, proposals]);

  // Stable across renders — the renderer re-initializes when its inputs
  // change identity, so these must be computed exactly once (empty deps:
  // `initialPatient` is fixed for this mount by design).
  const initialResponses = useMemo(
    () =>
      Object.fromEntries(
        PATIENT_FIELDS.map((spec) => [spec.id, { answer: spec.read(initialPatient) }]),
      ),
    [],
  );

  // Yjs → eSheet: push differing values into the renderer's form store.
  useEffect(() => {
    if (!formStore) {
      return;
    }
    const apply = (patient: Patient | null): void => {
      if (!patient) {
        return;
      }
      const state = formStore.getState();
      for (const spec of PATIENT_FIELDS) {
        const value = spec.read(patient);
        const current = state.getResponse(spec.id)?.answer ?? "";
        if (current !== value) {
          state.setResponse(spec.id, { answer: value });
        }
      }
    };
    apply(useCollabStore.getState().patient);
    return useCollabStore.subscribe((state, previous) => {
      if (state.patient !== previous.patient) {
        apply(state.patient);
      }
    });
  }, [formStore]);

  // eSheet → Yjs: write changed answers into the Y.Doc. Only fields whose
  // response object changed in this update are considered — during renderer
  // initialization the responses build up one by one, and diffing per field
  // prevents the not-yet-populated ones from erasing document state.
  useEffect(() => {
    if (!formStore) {
      return;
    }
    return formStore.subscribe((state, previous) => {
      if (state.responses === previous.responses) {
        return;
      }
      const { patient: currentPatient, setField } = useCollabStore.getState();
      if (!currentPatient) {
        return;
      }
      for (const spec of PATIENT_FIELDS) {
        if (state.responses[spec.id] === previous.responses[spec.id]) {
          continue;
        }
        const answer = state.responses[spec.id]?.answer ?? "";
        if (answer !== spec.read(currentPatient)) {
          setField(spec.id, answer);
        }
      }
    });
  }, [formStore]);

  // Suggestion decoration: outline the affected inputs and link them to
  // their chip via aria-describedby (the eSheet renderer owns the inputs, so
  // this is applied to the live DOM).
  useEffect(() => {
    for (const spec of PATIENT_FIELDS) {
      const input = document.querySelector<HTMLElement>(`.patient-form [id$="-answer-${spec.id}"]`);
      if (!input) {
        continue;
      }
      const chipId = `suggestion-${spec.id}`;
      const suggested = suggestions.some((suggestion) => suggestion.spec.id === spec.id);
      input.classList.toggle("field-has-suggestion", suggested);
      if (suggested) {
        input.setAttribute("aria-describedby", chipId);
      } else if (input.getAttribute("aria-describedby") === chipId) {
        input.removeAttribute("aria-describedby");
      }
    }
  }, [suggestions]);

  // Proposer resolution snap-back: when a field's suggestion is resolved
  // (accepted, rejected, or superseded by someone else) and no open
  // suggestion remains on that field, show the canonical value again — a
  // rejected suggestion must not linger in the proposer's inputs.
  const previousProposals = useRef<ChangeIntent[]>([]);
  useEffect(() => {
    const previous = previousProposals.current;
    previousProposals.current = proposals;
    const state = useCollabStore.getState();
    if (!formStore || state.role !== "proposer" || !state.patient) {
      return;
    }
    for (const before of previous) {
      if (before.status !== "proposed") {
        continue;
      }
      const after = proposals.find((candidate) => candidate.id === before.id);
      if (after?.status === "proposed") {
        continue;
      }
      for (const spec of PATIENT_FIELDS) {
        const path = spec.proposalPath(state.patient);
        if (!path || !samePath(path, before.path)) {
          continue;
        }
        // Skip when the field already has a newer open suggestion.
        if (suggestions.some((suggestion) => suggestion.spec.id === spec.id)) {
          continue;
        }
        const canonical = spec.read(state.patient);
        const form = formStore.getState();
        if ((form.getResponse(spec.id)?.answer ?? "") !== canonical) {
          form.setResponse(spec.id, { answer: canonical });
        }
      }
    }
  }, [proposals, suggestions, formStore]);

  return (
    <div
      className="patient-form"
      onFocusCapture={(event) => {
        const fieldId = fieldIdFromTarget(event.target);
        if (fieldId) {
          useCollabStore.getState().setFocusedField(fieldId);
        }
      }}
      onBlurCapture={(event) => {
        if (fieldIdFromTarget(event.target)) {
          const { setFocusedField, signalBlur } = useCollabStore.getState();
          setFocusedField(null);
          signalBlur();
        }
      }}
    >
      <p className="patient-form-hint">
        {role === "proposer" ? t("form.proposerHint") : t("form.subtitle")}
      </p>
      <EsheetRenderer
        ref={rendererRef}
        formDataInput={PATIENT_FORM}
        initialResponses={initialResponses}
        strict
        onReady={() => {
          setFormStore(rendererRef.current?.getFormStore() ?? null);
        }}
      />
      {suggestions.length > 0 && (
        <ul className="suggestion-chips" aria-label={t("suggestion.listLabel")}>
          {suggestions.map(({ spec, proposal }) => (
            <li key={proposal.id} id={`suggestion-${spec.id}`} className="suggestion-chip">
              {t("suggestion.chip", {
                field: t(spec.labelKey),
                value: formatFieldValue(proposal.proposedValue),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
