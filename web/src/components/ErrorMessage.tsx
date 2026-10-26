import type { ApiFailure } from "../api.ts";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";

export function ErrorMessage({ failure, id }: { failure: ApiFailure; id?: string }) {
  return (
    <p id={id} role="alert" className="error">
      {t(failure.code, messageParams(failure))}
    </p>
  );
}
