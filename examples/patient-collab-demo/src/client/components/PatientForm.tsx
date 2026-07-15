/**
 * The eSheet-rendered FHIR Patient form (PLAN.md 6b), wired both ways to the
 * Yjs-backed Zustand store:
 *
 * - Yjs → eSheet: whenever the materialized Patient changes, differing field
 *   responses are pushed into the renderer's form store;
 * - eSheet → Yjs: a form-store subscription writes changed answers into the
 *   Y.Doc (echo-safe: a value is only written when it actually differs).
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

import { t } from "../i18n";
import { PATIENT_FIELDS } from "../patientFields";
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
      <p className="patient-form-hint">{t("form.subtitle")}</p>
      <EsheetRenderer
        ref={rendererRef}
        formDataInput={PATIENT_FORM}
        initialResponses={initialResponses}
        strict
        onReady={() => {
          setFormStore(rendererRef.current?.getFormStore() ?? null);
        }}
      />
    </div>
  );
}
