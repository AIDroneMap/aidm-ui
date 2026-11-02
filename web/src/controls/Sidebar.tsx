import { useId, type ReactElement, type ReactNode } from "react";

/**
 * The navigation that is always there. A nav with lists of links, so Tab
 * reaches every item and no key needs handling of its own. Below 64 rem it
 * folds to icons, and an item shows its words on hover and focus.
 */
export function Sidebar({ label, header, children }: { label: string; header?: ReactNode; children: ReactNode }) {
  return (
    <nav className="sidebar" aria-label={label}>
      {header ? <div className="sidebar-header">{header}</div> : null}
      {children}
    </nav>
  );
}

/** A group of items, with an optional heading such as the open project's name. */
export function NavSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="nav-section">
      {title ? <p className="nav-section-title" id={id}>{title}</p> : null}
      <ul className="nav-list" aria-labelledby={title ? id : undefined}>{children}</ul>
    </div>
  );
}

type ItemProps = {
  href: string;
  icon: ReactElement;
  label: ReactNode;
  current?: boolean;
  /** A short count or mark beside the label, such as the number of photos. */
  badge?: ReactNode;
  /** What the badge means, in words, for screen readers. */
  badgeLabel?: string;
};

export function NavItem({ href, icon, label, current, badge, badgeLabel }: ItemProps) {
  return (
    <li>
      <a className="nav-item" href={href} aria-current={current ? "page" : undefined}>
        {icon}
        <span className="nav-label">{label}</span>
        {badge !== undefined && badge !== null ? (
          <>
            <span className="nav-badge" aria-hidden={badgeLabel ? true : undefined}>{badge}</span>
            {badgeLabel ? <span className="visually-hidden">{badgeLabel}</span> : null}
          </>
        ) : null}
      </a>
    </li>
  );
}
