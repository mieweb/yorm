/**
 * Live projection panel (PLAN.md 6c + 7c) — the "rows are projections" money
 * shot: the four SQLite contact tables plus the `yorm_proposal` tracking
 * table, polled from `/api/rows` and updated as the projection engine
 * commits. Pending proposals appear here as `yorm_proposal` rows while the
 * contact rows stay untouched until acceptance. Column and table names are
 * database identifiers, shown verbatim (they are not translatable UI copy).
 *
 * A commit is easy to miss in a wall of rows, so each new snapshot is diffed
 * against the previous one: a toast shows the SQL the projection engine just
 * ran (as the driver executed it, values inlined) and the cells that actually
 * changed flash.
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

/** Long enough to read a statement or two. */
const TOAST_MS = 6000;
/** Must outlast the `flash-update` keyframes in the stylesheet. */
const FLASH_MS = 1500;
/** A commit can touch every table; the toast shows the head of the batch. */
const TOAST_STATEMENTS = 4;

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

function cellValue(row: unknown, column: string): string {
  return (row as Record<string, string | null>)[column] ?? "";
}

function cellKey(table: RowsTableName, index: number, column: string): string {
  return `${table}:${index}:${column}`;
}

/**
 * Cells whose rendered value differs between two snapshots. Rows are matched
 * positionally — good enough to draw the eye, since the projection engine
 * rewrites these small tables in a stable order.
 */
function diffCells(previous: RowsSnapshot, next: RowsSnapshot): Set<string> {
  const changed = new Set<string>();
  for (const table of ROWS_TABLES) {
    const previousRows: unknown[] = previous[table];
    next[table].forEach((row, index) => {
      const before = previousRows[index];
      for (const column of TABLE_COLUMNS[table]) {
        if (before === undefined || cellValue(before, column) !== cellValue(row, column)) {
          changed.add(cellKey(table, index, column));
        }
      }
    });
  }
  return changed;
}

function RowsTable({
  table,
  rows,
  changedCells,
}: {
  table: RowsTableName;
  rows: RowsSnapshot[RowsTableName];
  changedCells: ReadonlySet<string>;
}) {
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
                  <TableCell
                    key={column}
                    data-changed={changedCells.has(cellKey(table, index, column)) || undefined}
                  >
                    {cellValue(row, column)}
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
  const sqlCommits = useCollabStore((state) => state.sqlCommits);
  const previousRows = useRef<RowsSnapshot | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [changedCells, setChangedCells] = useState<ReadonlySet<string>>(new Set());

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
    setChangedCells(diffCells(previous, rows));
    const toastTimer = setTimeout(() => setToastVisible(false), TOAST_MS);
    const flashTimer = setTimeout(() => setChangedCells(new Set()), FLASH_MS);
    return () => {
      clearTimeout(toastTimer);
      clearTimeout(flashTimer);
    };
  }, [rows]);

  const statements = sqlCommits.flatMap((commit) => commit.statements);
  const shown = statements.slice(0, TOAST_STATEMENTS);
  const overflow = statements.length - shown.length;
  // The rows now reflect the last commit, so that is the version to name.
  const version = sqlCommits.at(-1)?.documentVersion;

  return (
    <section className="projection-panel" aria-label={t("rows.title")}>
      <h2 className="projection-title">{t("rows.title")}</h2>
      <p className="projection-subtitle">{t("rows.subtitle")}</p>
      {/* The app shell's live region already announces row updates. */}
      <div
        className={`projection-toast${toastVisible ? " projection-toast--visible" : ""}`}
        aria-hidden="true"
      >
        <p className="projection-toast-title">
          {version === undefined ? t("rows.updated") : t("rows.updatedAt", { version })}
        </p>
        {shown.length > 0 && (
          <ol className="projection-toast-sql">
            {shown.map((statement, index) => (
              <li key={index}>
                <code>{statement}</code>
              </li>
            ))}
          </ol>
        )}
        {overflow > 0 && (
          <p className="projection-toast-more">{t("rows.moreStatements", { count: overflow })}</p>
        )}
      </div>
      {rows &&
        ROWS_TABLES.map((table) => (
          <RowsTable key={table} table={table} rows={rows[table]} changedCells={changedCells} />
        ))}
    </section>
  );
}
