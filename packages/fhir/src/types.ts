/**
 * Minimal structural FHIR R4 types used by the Contacts ⇄ Patient POC.
 *
 * These are pragmatic subsets, not a complete R4 type model: every field the
 * POC touches is typed, everything else rides along via index signatures so
 * unmapped content is preserved (design principle: keep the object).
 */

/** Any FHIR resource: `resourceType` plus arbitrary preserved content. */
export interface FhirResource {
  resourceType: string;
  id?: string;
  [k: string]: unknown;
}

/** FHIR Extension — `url` plus one `value[x]` (only POC-used variants typed). */
export interface Extension {
  url: string;
  valueString?: string;
  valueCode?: string;
  valueUrl?: string;
  [k: string]: unknown;
}

/** FHIR Identifier (subset). */
export interface Identifier {
  id?: string;
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  system?: string;
  value?: string;
  extension?: Extension[];
  [k: string]: unknown;
}

/** FHIR HumanName (subset). */
export interface HumanName {
  id?: string;
  use?: "usual" | "official" | "temp" | "nickname" | "anonymous" | "old" | "maiden";
  text?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
  extension?: Extension[];
  [k: string]: unknown;
}

/** FHIR ContactPoint (subset). */
export interface ContactPoint {
  id?: string;
  system?: "phone" | "fax" | "email" | "pager" | "url" | "sms" | "other";
  value?: string;
  use?: "home" | "work" | "temp" | "old" | "mobile";
  rank?: number;
  extension?: Extension[];
  [k: string]: unknown;
}

/** FHIR Address (subset). */
export interface Address {
  id?: string;
  use?: "home" | "work" | "temp" | "old" | "billing";
  type?: "postal" | "physical" | "both";
  text?: string;
  line?: string[];
  city?: string;
  district?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  extension?: Extension[];
  [k: string]: unknown;
}

/** FHIR Patient (subset used by the POC). */
export interface Patient extends FhirResource {
  resourceType: "Patient";
  identifier?: Identifier[];
  active?: boolean;
  name?: HumanName[];
  telecom?: ContactPoint[];
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string;
  address?: Address[];
  extension?: Extension[];
}
