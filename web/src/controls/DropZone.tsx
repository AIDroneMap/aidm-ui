import { useId, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { IconUpload } from "../icons/icons.tsx";
import { t } from "../i18n/translate.ts";
import { Button } from "./Button.tsx";

type Props = {
  title: ReactNode;
  /** One sentence on what to drop here. */
  hint?: ReactNode;
  /** The words on the button that opens the file picker: the way in for the keyboard and for anyone who does not drag. */
  chooseLabel: ReactNode;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Files from the picker. */
  onChoose: (files: File[]) => void;
  /** What was dropped. The screen reads folders out of it, which a file list cannot hold. */
  onDrop: (data: DataTransfer) => void;
  children?: ReactNode;
};

/** A large area that takes dropped files, with a button that does the same for the keyboard. */
export function DropZone({ title, hint, chooseLabel, accept, multiple = true, disabled, onChoose, onDrop, children }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  function enter(event: DragEvent) {
    if (disabled) return;
    event.preventDefault();
    setOver(true);
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    if (!disabled) onDrop(event.dataTransfer);
  }
  function chosen(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length) onChoose(files);
  }
  return (
    <div
      className="drop-zone"
      data-over={over || undefined}
      aria-disabled={disabled || undefined}
      onDragEnter={enter}
      onDragOver={enter}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
      onDrop={drop}
    >
      <IconUpload />
      <p className="drop-zone-title" id={`${id}-title`}>{title}</p>
      {hint ? <p className="drop-zone-hint">{hint}</p> : null}
      <input ref={input} id={id} type="file" className="visually-hidden" tabIndex={-1} aria-hidden="true" accept={accept} multiple={multiple} disabled={disabled} onChange={chosen} />
      <Button variant="secondary" disabled={disabled} aria-describedby={`${id}-title`} onClick={() => input.current?.click()}>{chooseLabel}</Button>
      {children}
      <p className="drop-zone-release" aria-hidden="true">{t("ui.drop.release")}</p>
    </div>
  );
}
