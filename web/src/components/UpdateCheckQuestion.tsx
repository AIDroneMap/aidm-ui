import { RadioGroup } from "../controls/RadioGroup.tsx";
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
    <RadioGroup
      name={`${props.idPrefix}-update`}
      legend={t("updates.question")}
      describedBy={sentId}
      busy={props.saving}
      options={OPTIONS.map((option) => ({ value: option, label: t(`updates.option.${option}`), disabled: props.loading }))}
      value={props.value}
      onChange={props.onChange}
    >
      <p id={sentId} className="hint">
        {t("updates.sent")}
      </p>
    </RadioGroup>
  );
}
