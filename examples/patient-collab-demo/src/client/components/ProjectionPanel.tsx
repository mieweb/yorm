/**
 * Live projection panel (PLAN.md 6c) — the "rows are projections" money
 * shot: the four SQLite contact tables, polled from `/api/rows` and updated
 * as the projection engine commits. Column and table names are database
 * identifiers, shown verbatim (they are not translatable UI copy).
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mieweb/ui";
import { CONTACT_TABLES } from "example-fhir-patient-contacts/schema";

import type { RowsSnapshot } from "../api";
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./projection-panel.scss";

type ContactTable = (typeof CONTACT_TABLES)[number];

const TABLE_COLUMNS: Record<ContactTable, readonly string[]> = {
  contact: [
    "contact_id",
    "first",
    "last",
    "middle",
    "nickname",
    "organization",
    "birthday",
    "note",
    "image_ref",
  ],
  contact_multivalue: ["contact_id", "element_id", "property", "label", "value"],
  contact_multivalue_entry: [
    "contact_id",
    "element_id",
    "property",
    "label",
    "entry_key",
    "entry_value",
  ],
  contact_raw_property: ["contact_id", "property", "value"],
};

function RowsTable({ table, rows }: { table: ContactTable; rows: RowsSnapshot[ContactTable] }) {
  const columns = TABLE_COLUMNS[table];
  return (
    <div className="projection-table">
      <h3 className="projection-table-name">
        <code>{table}</code>
      </h3>
      {rows.length === 0 ? (
        <p className="projection-table-empty">{t("rows.empty")}</p>
      ) : (
        <Table aria-label={table}>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column}>
                  <code>{column}</code>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={index}>
                {columns.map((column) => (
                  <TableCell key={column}>
                    {(row as unknown as Record<string, string | null>)[column] ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function ProjectionPanel(): React.JSX.Element {
  const rows = useCollabStore((state) => state.rows);

  return (
    <section className="projection-panel" aria-label={t("rows.title")}>
      <h2 className="projection-title">{t("rows.title")}</h2>
      <p className="projection-subtitle">{t("rows.subtitle")}</p>
      {rows &&
        CONTACT_TABLES.map((table) => <RowsTable key={table} table={table} rows={rows[table]} />)}
    </section>
  );
}
