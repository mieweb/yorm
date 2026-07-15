/**
 * Seed script: contacts fixture → canonical Patient documents → projected
 * contact rows. Run with `pnpm --filter example-fhir-patient-contacts seed`.
 * Set `YORM_SQLITE_FILE=contacts-poc.db` to persist instead of in-memory.
 */
import { contactRowCounts, createPocServer, loadContactsFixture, seedContacts } from "./setup.js";

const file = process.env.YORM_SQLITE_FILE;
const poc = createPocServer(file !== undefined ? { file } : {});
const records = loadContactsFixture();
const patients = await seedContacts(poc.yorm, records);

console.log(`Seeded ${patients.length} contact(s) into ${file ?? "in-memory SQLite"}.\n`);
for (const patient of patients) {
  console.log(`Canonical FHIR Patient "${patient.id}":`);
  console.log(JSON.stringify(patient, null, 2));
}
console.log("\nProjected row counts:", contactRowCounts(poc.db));
poc.close();
