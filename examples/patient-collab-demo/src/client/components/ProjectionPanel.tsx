/**
 * Live projection panel (PLAN.md 6c + 7c) — the "rows are projections" money
 * shot: the four SQLite contact tables plus the `yorm_proposal` tracking
 * table, polled from `/api/rows` and updated as the projection engine
 * commits. Pending proposals appear here as `yorm_proposal` rows while the
 * contact rows stay untouched until acceptance. Column and table names are
 * database identifiers, shown verbatim (they are not translatable UI copy).
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mieweb/ui";
import { CONTACT_TABLES } from "example-fhir-patient-contacts/schema";
import { useEffect, useRef, useState } from "react";

import type { RowsSnapshot } from "../api";
import { t } from "../i18n";
import { useCollabStore } from "../store";
import "./projection-panel.scss";

const ROWS_TABLES = [...CONTACT_TABLES, "yorm_proposal"] as const;

type RowsTableName = (typeof ROWS_TABLES)[number];

const TOAST_MS = 3000;

const TABLE_COLUMNS: Record<RowsTableName, readonly string[]> = {
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
  yorm_proposal: ["proposal_id", "path", "op", "status", "actor"],
};

function RowsTable({ table, rows }: { table: RowsTableName; rows: RowsSnapshot[RowsTableName] }) {
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
  const previousRows = useRef<RowsSnapshot | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    if (!rows) {
      return;
    }
    const previous = previousRows.current;
    previousRows.current = rows;
    // The first snapshot is the initial load, not a change worth announcing.
    if (!previous || JSON.stringify(previous) === JSON.stringify(rows)) {
      return;
    }
    setToastVisible(true);
    const timer = setTimeout(() => setToastVisible(false), TOAST_MS);
    return () => clearTimeout(timer);
  }, [rows]);

  return (
    <section className="projection-panel" aria-label={t("rows.title")}>
      {/* The app shell's live region already announces row updates. */}
      <div
        className={`projection-toast${toastVisible ? " projection-toast--visible" : ""}`}
        aria-hidden="true"
      >
        {t("rows.updated")}
      </div>
      <h2 className="projection-title">{t("rows.title")}</h2>
      <p className="projection-subtitle">{t("rows.subtitle")}</p>
      {rows &&
        ROWS_TABLES.map((table) => <RowsTable key={table} table={table} rows={rows[table]} />)}
    </section>
  );
}
