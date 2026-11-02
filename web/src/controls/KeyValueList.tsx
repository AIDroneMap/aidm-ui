import type { ReactNode } from "react";

export type KeyValue = { id: string; key: ReactNode; value: ReactNode };

/** Facts as name and value, in two columns that fold to one on a narrow screen. */
export function KeyValueList({ items }: { items: readonly KeyValue[] }) {
  return (
    <dl className="key-value">
      {items.map((item) => (
        <div className="key-value-row" key={item.id}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
