import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  /** One line under the title: what this screen is for, or the facts of what it shows. */
  subtitle?: ReactNode;
  /** The screen's actions, the primary one last. */
  actions?: ReactNode;
};

/**
 * The top of a screen. The heading takes the focus when the screen opens
 * (tabIndex -1), so a screen reader starts there.
 */
export function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 tabIndex={-1}>{title}</h1>
        {subtitle ? <p className="page-header-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
