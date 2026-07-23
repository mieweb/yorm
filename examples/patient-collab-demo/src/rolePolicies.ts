/**
 * Demo role policies (role-security POC) — the role names WHO is connecting
 * (physician / nurse / receptionist), as opposed to the write mode
 * (editor / proposer) which names HOW a connection writes.
 *
 * Shared by the server — which enforces them with the `@yorm/hono` policy
 * lens (a derived, redacted Y.Doc per role; see `packages/yjs/src/policy`) —
 * and the client, which mirrors the writable-key lists cosmetically: hidden
 * fields simply never arrive in the synced document, and protected sections
 * render read-only so the UI doesn't invite writes the server would refuse.
 */
import { defineRolePolicy } from "@yorm/yjs";
import type { RolePolicy, ViewChange } from "@yorm/yjs";

export type DemoRole = "physician" | "nurse" | "receptionist";

export const DEMO_ROLES: readonly DemoRole[] = ["physician", "nurse", "receptionist"];

/** Top-level Patient keys the receptionist may see (demographics only). */
const RECEPTIONIST_VISIBLE = [
  "resourceType",
  "id",
  "active",
  "name",
  "telecom",
  "gender",
  "birthDate",
] as const;

/**
 * Top-level Patient keys each role may change (`null` = no policy, full
 * access). The server derives `canWrite` from this; the client derives the
 * read-only state of each editor section from the same lists.
 */
export const ROLE_WRITABLE_KEYS: Record<DemoRole, readonly string[] | null> = {
  physician: null,
  nurse: ["telecom", "address"],
  receptionist: ["name", "telecom"],
};

type PatientJson = Record<string, unknown>;

function pickKeys(object: PatientJson, keys: readonly string[]): PatientJson {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

/** `canWrite` that permits changes to the allowed top-level keys only. */
function onlyChanges(allowed: readonly string[]) {
  return ({ before, after }: ViewChange): boolean => {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (!allowed.includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        return false;
      }
    }
    return true;
  };
}

/**
 * The lens policies the demo server registers. The physician has no policy
 * entry on purpose: no lens means full canonical access.
 */
export const demoRolePolicies: RolePolicy[] = [
  // Receptionist: sees demographics only; may fix names and contact points.
  defineRolePolicy<PatientJson>({
    role: "receptionist",
    documentType: "Patient",
    view: (patient) => pickKeys(patient, RECEPTIONIST_VISIBLE),
    canWrite: onlyChanges(ROLE_WRITABLE_KEYS.receptionist ?? []),
  }) as RolePolicy,
  // Nurse: sees everything, but identity fields are read-only.
  defineRolePolicy<PatientJson>({
    role: "nurse",
    documentType: "Patient",
    canWrite: onlyChanges(ROLE_WRITABLE_KEYS.nurse ?? []),
  }) as RolePolicy,
];

/** Parses a `?role=` URL value, defaulting to the unrestricted physician. */
export function parseDemoRole(value: string | null): DemoRole {
  return DEMO_ROLES.includes(value as DemoRole) ? (value as DemoRole) : "physician";
}

/** May this role edit fields stored under any of these top-level keys? */
export function roleMayEdit(role: DemoRole, topKeys: readonly string[]): boolean {
  const writable = ROLE_WRITABLE_KEYS[role];
  return writable === null || topKeys.some((key) => writable.includes(key));
}
