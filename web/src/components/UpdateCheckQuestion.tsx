import { t } from "../i18n/translate.ts";
import type { UpdateCheck } from "../../../shared/api-types.ts";

export interface UpdateCheckQuestionProps {
  /** Prefix for the ids, so the question can sit twice in the app without clashing. */
  idPrefix: string;
  /** Null until the operator has answered. */
  value: UpdateCheck | null;
  /** True while the answer is being saved. */
  saving: boolean;
  /** True until the packages have loaded, because there is nothing to bind to yet. */
  loading: boolean;
  onChange: (value: UpdateCheck) => void;
}

const OPTIONS: readonly UpdateCheck[] = ["daily", "never"];

/** The one question about update checks, with a plain statement of what is sent. */
export function UpdateCheckQuestion(props: UpdateCheckQuestionProps) {
  const sentId = `${props.idPrefix}-update-sent`;
  return (
    <fieldset aria-describedby={sentId}>
      <legend>{t("updates.question")}</legend>
      {OPTIONS.map((option) => {
        const id = `${props.idPrefix}-update-${option}`;
        return (
          <div className="check" key={option}>
            <input
              id={id}
              type="radio"
              name={`${props.idPrefix}-update-check`}
              value={option}
              checked={props.value === option}
              disabled={props.loading}
              aria-disabled={props.saving ? "true" : undefined}
              onChange={() => {
                if (!props.saving) props.onChange(option);
              }}
            />
            <label htmlFor={id}>{t(`updates.option.${option}`)}</label>
          </div>
        );
      })}
      <p id={sentId} className="hint">
        {t("updates.sent")}
      </p>
    </fieldset>
  );
}
