import type { ReactNode } from "react";
import { t } from "../i18n/translate.ts";
import { Button } from "./Button.tsx";
import { Table } from "./Table.tsx";

export type Difference = {
  id: string;
  name: ReactNode;
  /** The engine's flag or another code under the name. */
  code?: string;
  from: ReactNode;
  to: ReactNode;
  /** The words a screen reader says for this row's reset button, naming the row. */
  resetLabel?: string;
};

type Props = {
  label: ReactNode;
  /** Column headings: the thing, what it is compared to, what it is now. */
  columns: { name: ReactNode; from: ReactNode; to: ReactNode };
  rows: readonly Difference[];
  /** Puts a reset button on each row. */
  onReset?: (id: string) => void;
  /** What to say when nothing differs. */
  empty: ReactNode;
};

/** What changed against a reference, such as the engine's defaults or a saved preset, one row each. */
export function DiffPanel({ label, columns, rows, onReset, empty }: Props) {
  if (rows.length === 0) return <div className="diff-panel"><p className="diff-label">{label}</p><p className="diff-empty">{empty}</p></div>;
  return (
    <div className="diff-panel">
      <Table label={label} dense>
        <thead>
          <tr>
            <th scope="col">{columns.name}</th>
            <th scope="col">{columns.from}</th>
            <th scope="col">{columns.to}</th>
            {onReset ? <th scope="col"><span className="visually-hidden">{t("ui.diff.actions")}</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <span className="diff-name">{row.name}</span>
                {row.code ? <code className="diff-code">{row.code}</code> : null}
              </th>
              <td className="diff-from">{row.from}</td>
              <td className="diff-to">{row.to}</td>
              {onReset ? <td><Button variant="quiet" aria-label={row.resetLabel} onClick={() => onReset(row.id)}>{t("ui.diff.reset")}</Button></td> : null}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
