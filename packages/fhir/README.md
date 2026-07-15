# @yorm/fhir

FHIR building blocks for YORM: a resource-aware JSON codec, stable element
identity, and extension preservation helpers. This is the **minimum slice**
for the Contacts ⇄ Patient POC (PLAN.md Milestone 5a) — not a FHIR validator,
terminology server, or full R4 type model. See the root
[README](../../README.md) ("A FHIR-first motivation", "Stable identity",
"Source codecs", "FHIR-specific patterns") and [PLAN.md](../../PLAN.md).

## What's in the minimum slice

### Resource codec — `fhirResource(resourceType)`

A thin, resource-type-aware layer over the generic `@yorm/yjs` `jsonCodec`
(all Yjs traversal is delegated). Uses the default `"resource"` root map, so
it composes with `@yorm/yjs` document sessions.

```ts
import { fhirResource, type Patient } from "@yorm/fhir";

const codec = fhirResource<Patient>("Patient");
codec.write(doc, patient); // throws if patient.resourceType !== "Patient"
const read = codec.read(doc); // resourceType guaranteed on the result
```

Minimal structural types used by the POC are exported alongside:
`FhirResource`, `Patient`, `HumanName`, `ContactPoint`, `Address`,
`Extension`, `Identifier` — pragmatic subsets with index signatures so
unmapped content is preserved.

### Stable element identity — `fhirElementId`, `ensureElementIds`

Array position is not identity. Identity precedence:

1. explicit element `id`;
2. configured business key (`options.businessKey`);
3. ingestion-assigned id (`options.assign`, default: short random id) —
   applied by `ensureElementIds` only. `fhirElementId` **throws** at step 3,
   because assigning at read time would not be stable.

```ts
import { ensureElementIds, fhirElementId } from "@yorm/fhir";

// On ingestion: give every repeating element a stable id (immutable copy).
const patient = ensureElementIds(raw, [["name"], ["telecom"], ["address"]]);

// In mappings: resolve the stable identity of one element.
const rowKey = fhirElementId(telecom);
```

### Extension preservation — `src/extensions.ts`

Unmapped contact fields ride along on the canonical resource as FHIR
extensions under the documented namespace
`https://yorm.dev/fhir/StructureDefinition/<name>`:

```ts
import { extensionUrl, setExtension, getExtensionValue, listYormExtensions } from "@yorm/fhir";

const url = extensionUrl("contact-ringtone");
const next = setExtension(telecom, url, { valueString: "Marimba" }); // immutable, replace-by-url
getExtensionValue(next, url); // "Marimba"
listYormExtensions(next); // all extensions under the yorm namespace
```

All helpers are immutable: they return copies and never mutate their input.
