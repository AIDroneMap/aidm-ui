import { useEffect, useId, useRef, type ReactNode } from "react";
import { t } from "../i18n/translate.ts";
import { Button } from "./Button.tsx";

type Props = {
  open: boolean;
  title: ReactNode;
  /** What goes and what stays. */
  children: ReactNode;
  /** The words on the confirming button. For a destructive action, name it with its size. */
  confirmLabel: ReactNode;
  /** The words on the button that changes nothing. Keep, unless the screen says otherwise. */
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** A destructive action: the confirming button is red. */
  danger?: boolean;
  /** While the action runs: both buttons wait. */
  busy?: boolean;
};

/**
 * A modal question with two answers. The answer that changes nothing has the
 * focus when it opens, so Enter or a slip of the hand never deletes. Escape
 * is the same as that answer.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel, onConfirm, onCancel, danger, busy }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      keep.current?.focus();
    } else if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog ref={dialog} className={danger ? "confirm-dialog confirm-danger" : "confirm-dialog"} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id={titleId} className="dialog-title">{title}</h2>
      <div className="confirm-body">{children}</div>
      <div className="dialog-actions">
        <Button ref={keep} variant="secondary" disabled={busy} onClick={onCancel}>{cancelLabel ?? t("ui.confirm.keep")}</Button>
        <Button variant={danger ? "danger" : "primary"} disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </dialog>
  );
}
