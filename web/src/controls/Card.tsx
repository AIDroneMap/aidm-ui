import { useId, type ReactNode } from "react";

type Props = {
  /** Names the card for screen readers too: a card with a title is a labelled region. */
  title?: ReactNode;
  level?: 2 | 3;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** A raised panel that groups what belongs together on a screen. */
export function Card({ title, level = 2, actions, className, children }: Props) {
  const id = useId();
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className={className ? `card ${className}` : "card"} aria-labelledby={title ? id : undefined}>
      {title || actions ? (
        <header className="card-header">
          {title ? <Heading id={id} className="card-title">{title}</Heading> : null}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
