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
 * Collaboration renders natively through the renderer's `collab` prop
 * (vendor/eSheet, branch `yorm-collab-decorations`): peers' focused fields
 * become presence dots, open suggestions become per-field adornments — with
 * Accept / Reject for editors (Accept anyway on a stale-accept conflict) and
 * read-only for proposers — linked to the input via aria-describedby.
 *
 * The form definition itself is editable (FormConfigPanel): fields whose id
 * matches a `patientFields` spec stay two-way bound to the document; unknown
 * ids render but are listed as unbound. The applied definition persists per
 * document in localStorage.
 *
 * Focus/blur are captured on the wrapper to feed awareness presence and the
 * `on-blur` projection signal. eSheet field inputs carry ids ending in
 * `-answer-<fieldId>`, which is how the focused field is identified.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formDefinitionSchema } from "@esheet/core";
import type {
  CollabDecorations,
  FieldDefinition,
  FieldPresence,
  FieldProposal,
  FormDefinition,
  FormStore,
} from "@esheet/core";
import { EsheetRenderer } from "@esheet/renderer";
import type { EsheetRendererHandle } from "@esheet/renderer";
import type { Patient } from "@yorm/fhir";
import type { ChangeIntent } from "@yorm/yjs";

import { DOC_ID } from "../api";
import { t } from "../i18n";
import { PATIENT_FIELDS, formatFieldValue, getFieldSpec, samePath } from "../patientFields";
import type { PatientFieldSpec } from "../patientFields";
import { useCollabStore } from "../store";
import { useProposalActions } from "../useProposalActions";
import { FormConfigPanel } from "./FormConfigPanel";
import "./patient-form.scss";

const DEFAULT_PATIENT_FORM: FormDefinition = {
  id: "patient-demo-form",
  title: t("form.title"),
  fields: PATIENT_FIELDS.map((spec) => ({
    fieldType: "text",
    id: spec.id,
    question: t(spec.labelKey),
    inputType: spec.inputType,
  })),
};

/** localStorage key for the persisted (edited) form definition. */
const STORAGE_KEY = `patient-collab-demo:form-definition:${DOC_ID}`;

function loadStoredDefinition(): FormDefinition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const result = formDefinitionSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as FormDefinition) : null;
  } catch {
    return null;
  }
}

/** eSheet input ids end in `-answer-<fieldId>`. */
function fieldIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement) || target.id === "") {
    return null;
  }
  const match = /-answer-(.+)$/.exec(target.id);
  return match?.[1] ?? null;
}

/** Ids of the definition's input fields (recursing into sections). */
function collectInputFieldIds(
  fields: readonly FieldDefinition[],
  into = new Set<string>(),
): Set<string> {
  for (const field of fields) {
    const children = (field as { fields?: FieldDefinition[] }).fields;
    if (field.fieldType === "section" && children) {
      collectInputFieldIds(children, into);
    } else if (!["section", "display", "html"].includes(field.fieldType)) {
      into.add(field.id);
    }
  }
  return into;
}

/** The latest open proposal per bound form field, matched by proposal path. */
interface FieldSuggestion {
  spec: PatientFieldSpec;
  proposal: ChangeIntent;
}

function fieldSuggestions(
  patient: Patient | null,
  proposals: ChangeIntent[],
  specs: readonly PatientFieldSpec[],
): FieldSuggestion[] {
  if (!patient) {
    return [];
  }
  const open = proposals.filter((proposal) => proposal.status === "proposed");
  const suggestions: FieldSuggestion[] = [];
  for (const spec of specs) {
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

/** Waits for the first synced Patient, then mounts the config panel + form. */
export function PatientForm(): React.JSX.Element | null {
  const patient = useCollabStore((state) => state.patient);
  const [definition, setDefinition] = useState<FormDefinition>(
    () => loadStoredDefinition() ?? DEFAULT_PATIENT_FORM,
  );
  const [revision, setRevision] = useState(0);
  if (!patient) {
    return null;
  }

  const apply = (next: FormDefinition): void => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage full / unavailable — the definition still applies in-memory
    }
    setDefinition(next);
    setRevision((n) => n + 1);
  };

  const reset = (): void => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore — same as apply
    }
    setDefinition(DEFAULT_PATIENT_FORM);
    setRevision((n) => n + 1);
  };

  return (
    <div className="patient-form-view">
      <FormConfigPanel
        definition={definition}
        revision={revision}
        onApply={apply}
        onReset={reset}
      />
      {/* Remount on definition change: the renderer re-initializes cleanly
          and re-seeds its responses from the current Patient. */}
      <SyncedPatientForm key={revision} initialPatient={patient} definition={definition} />
    </div>
  );
}

interface SyncedPatientFormProps {
  initialPatient: Patient;
  definition: FormDefinition;
}

function SyncedPatientForm({
  initialPatient,
  definition,
}: SyncedPatientFormProps): React.JSX.Element {
  const rendererRef = useRef<EsheetRendererHandle>(null);
  const [formStore, setFormStore] = useState<FormStore | null>(null);
  const mode = useCollabStore((state) => state.mode);
  const patient = useCollabStore((state) => state.patient);
  const peers = useCollabStore((state) => state.peers);
  const proposals = useCollabStore((state) => state.proposals);
  const { conflicts, resolve } = useProposalActions();

  // Which definition fields are bound to the Patient document (id matches a
  // known spec) vs rendered unbound. The definition is fixed for this mount
  // (the parent remounts on change), so these are stable.
  const definitionFieldIds = useMemo(() => collectInputFieldIds(definition.fields), [definition]);
  const boundFields = useMemo(
    () => PATIENT_FIELDS.filter((spec) => definitionFieldIds.has(spec.id)),
    [definitionFieldIds],
  );
  const unboundFieldIds = useMemo(
    () => [...definitionFieldIds].filter((id) => !getFieldSpec(id)),
    [definitionFieldIds],
  );

  const suggestions = useMemo(
    () => fieldSuggestions(patient, proposals, boundFields),
    [patient, proposals, boundFields],
  );

  // Stable across renders — the renderer re-initializes when its inputs
  // change identity, so these must be computed exactly once (empty deps:
  // `initialPatient` and `boundFields` are fixed for this mount by design).
  const initialResponses = useMemo(
    () =>
      Object.fromEntries(
        boundFields.map((spec) => [spec.id, { answer: spec.read(initialPatient) }]),
      ),
    [],
  );

  // Collab decorations for the renderer: presence dots for peers' focused
  // fields and per-field suggestion adornments (actions for editors only).
  const collab = useMemo<CollabDecorations>(() => {
    const presenceByField: Record<string, FieldPresence[]> = {};
    for (const peer of peers) {
      if (peer.isLocal || peer.focusedField === null) {
        continue;
      }
      (presenceByField[peer.focusedField] ??= []).push({ name: peer.name, color: peer.color });
    }
    const proposalsByField: Record<string, FieldProposal[]> = {};
    for (const { spec, proposal } of suggestions) {
      (proposalsByField[spec.id] ??= []).push({
        id: proposal.id,
        proposedValue: proposal.proposedValue,
        baseValue: proposal.baseValue,
        actor: proposal.actor,
        status: proposal.status,
        ...(proposal.id in conflicts ? { conflict: { currentValue: conflicts[proposal.id] } } : {}),
      });
    }
    return {
      presenceByField,
      proposalsByField,
      canResolve: mode === "editor",
      onProposalAction: (_fieldId, proposalId, action) => void resolve(proposalId, action),
      formatValue: formatFieldValue,
    };
  }, [peers, suggestions, conflicts, mode, resolve]);

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
      for (const spec of boundFields) {
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
  }, [formStore, boundFields]);

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
      for (const spec of boundFields) {
        if (state.responses[spec.id] === previous.responses[spec.id]) {
          continue;
        }
        const answer = state.responses[spec.id]?.answer ?? "";
        if (answer !== spec.read(currentPatient)) {
          setField(spec.id, answer);
        }
      }
    });
  }, [formStore, boundFields]);

  // Proposer resolution snap-back: when a field's suggestion is resolved
  // (accepted, rejected, or superseded by someone else) and no open
  // suggestion remains on that field, show the canonical value again — a
  // rejected suggestion must not linger in the proposer's inputs.
  const previousProposals = useRef<ChangeIntent[]>([]);
  useEffect(() => {
    const previous = previousProposals.current;
    previousProposals.current = proposals;
    const state = useCollabStore.getState();
    if (!formStore || state.mode !== "proposer" || !state.patient) {
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
      for (const spec of boundFields) {
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
  }, [proposals, suggestions, formStore, boundFields]);

  return (
    <div
      className="patient-form"
      // Flips once the eSheet form store is wired to the Y.Doc — edits made
      // before that would be lost (the e2e view-toggle spec waits for it).
      data-ready={formStore !== null}
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
        {mode === "proposer" ? t("form.proposerHint") : t("form.subtitle")}
      </p>
      <EsheetRenderer
        ref={rendererRef}
        formDataInput={definition}
        initialResponses={initialResponses}
        strict
        collab={collab}
        onReady={() => {
          setFormStore(rendererRef.current?.getFormStore() ?? null);
        }}
      />
      {unboundFieldIds.length > 0 && (
        <p className="patient-form-unbound">
          {t("config.unbound", { fields: unboundFieldIds.join(", ") })}
        </p>
      )}
    </div>
  );
}
