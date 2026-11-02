import type { ReactElement, ReactNode } from "react";

type Props = {
  icon: ReactElement;
  title?: ReactNode;
  /** One sentence on what to do next. */
  children: ReactNode;
  /** The one action that does it. */
  action?: ReactNode;
};

/** What a screen shows before it has anything: an icon, one sentence, one action. */
export function EmptyState({ icon, title, children, action }: Props) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      {title ? <h2 className="empty-state-title">{title}</h2> : null}
      <p className="empty-state-text">{children}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
