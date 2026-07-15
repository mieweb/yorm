# Fixtures

Shared, framework-free test data used by golden tests and round-trip suites.

- [fhir-r4/patient/](fhir-r4/patient/) — FHIR R4 `Patient` resources (JSON). Elements that
  become projection rows carry explicit `id`s (stable element identity, README "Stable
  identity").
- [contacts/](contacts/) — phone-style contact records matching the Apple
  AddressBook-inspired schema from PLAN.md M5b (`contact`, `contact_multivalue`,
  `contact_multivalue_entry`, `contact_raw_property`).
