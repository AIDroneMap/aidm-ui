import { useEffect, useRef, useState } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import { WIZARD_STEPS, useWizardStep, wizardHash, type WizardStep } from "../router.ts";
import type { MachineCheckView as MachineCheckData, WizardUpdateRequest, WizardView } from "../../../shared/api-types.ts";
import type { ApiError } from "../../../shared/api-error.ts";

function Heading({ children }: { children: string }) {
  // The container moves focus here when the screen changes.
  return (
    <h1 id="wizard-title" tabIndex={-1}>
      {children}
    </h1>
  );
}

function Sentence({ error }: { error: ApiError }) {
  return <>{t(error.code, messageParams(error))}</>;
}

export function StepIndicator({ step }: { step: WizardStep }) {
  const current = WIZARD_STEPS.indexOf(step) + 1;
  return (
    <div className="wizard-steps">
      <p>{t("wizard.step", { current, total: WIZARD_STEPS.length })}</p>
      <ol aria-label={t("wizard.steps_label")}>
        {WIZARD_STEPS.map((name) => (
          <li key={name} aria-current={name === step ? "step" : undefined}>
            {t(`wizard.step.${name}`)}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WelcomeScreen({ onNext }: { onNext: () => void }) {
  return (
    <>
      <Heading>{t("wizard.welcome.title")}</Heading>
      <p>{t("wizard.welcome.body")}</p>
      <p>{t("wizard.welcome.next_steps")}</p>
      <div className="actions">
        <button type="button" onClick={onNext}>
          {t("wizard.next")}
        </button>
      </div>
    </>
  );
}

export interface MachineCheckScreenProps {
  /** Null until the first answer. */
  check: MachineCheckData | null;
  failure: ApiFailure | null;
  checking: boolean;
  /** Said by the status area after a new check, so a screen reader hears it. */
  announcement: string;
  onCheckAgain: () => void;
  onBack: () => void;
  onNext: () => void;
}

export function MachineCheckScreen(props: MachineCheckScreenProps) {
  const { check } = props;
  return (
    <>
      <Heading>{t("wizard.check.title")}</Heading>
      <p>{t("wizard.check.intro")}</p>
      {check ? (
        <ul className="check-lines" aria-label={t("wizard.check.list_label")}>
          {check.lines.map((line) => (
            <li key={line.id}>
              <span className="check-name">{t(`wizard.check.line.${line.id}`)}</span>
              <span className={`result result-${line.result}`}>
                <span className={`marker marker-${line.result}`} aria-hidden="true"></span>
                {t(`wizard.result.${line.result}`)}
              </span>
              <span className="check-message">
                <Sentence error={line.message} />
              </span>
            </li>
          ))}
        </ul>
      ) : props.failure ? null : (
        <p>{t("wizard.check.loading")}</p>
      )}
      {props.failure && <ErrorMessage failure={props.failure} />}
      <p role="status" className="visually-hidden">
        {props.announcement}
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={props.onBack}>
          {t("wizard.back")}
        </button>
        <button type="button" className="secondary" disabled={props.checking} onClick={props.onCheckAgain}>
          {props.checking ? t("wizard.check.checking") : t("wizard.check.again")}
        </button>
        <button type="button" onClick={props.onNext}>
          {t("wizard.next")}
        </button>
      </div>
    </>
  );
}

export interface EngineChoiceScreenProps {
  check: MachineCheckData | null;
  /** True while "use without an engine" is being saved. */
  busy: boolean;
  failure: ApiFailure | null;
  onInstall: () => void;
  onUiOnly: () => void;
  onBack: () => void;
}

export function EngineChoiceScreen(props: EngineChoiceScreenProps) {
  const local = props.check?.localEngine ?? null;
  return (
    <>
      <Heading>{t("wizard.engine.title")}</Heading>
      <p>{t("wizard.engine.intro")}</p>

      <div className="choice">
        <h2>{t("wizard.engine.install.title")}</h2>
        {local?.offered ? (
          <>
            <p>{t("wizard.engine.install.body")}</p>
            <button type="button" disabled={props.busy} onClick={props.onInstall}>
              {t("wizard.engine.install.button")}
            </button>
          </>
        ) : local ? (
          <p>{local.reason ? <Sentence error={local.reason} /> : t("wizard.engine.install.unavailable")}</p>
        ) : (
          <p>{t("wizard.engine.install.checking")}</p>
        )}
      </div>

      <div className="choice">
        <h2>{t("wizard.engine.remote.title")}</h2>
        <p>{t("wizard.engine.remote.body")}</p>
        <a className="button" href="#/engines">
          {t("wizard.engine.remote.button")}
        </a>
      </div>

      <div className="choice">
        <h2>{t("wizard.engine.ui_only.title")}</h2>
        <p>{t("wizard.engine.ui_only.body")}</p>
        <button type="button" className="secondary" disabled={props.busy} onClick={props.onUiOnly}>
          {t("wizard.engine.ui_only.button")}
        </button>
      </div>

      {props.failure && <ErrorMessage failure={props.failure} />}
      <div className="actions">
        <button type="button" className="secondary" onClick={props.onBack}>
          {t("wizard.back")}
        </button>
      </div>
    </>
  );
}

export function InstallScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <>
      <Heading>{t("wizard.install.title")}</Heading>
      <p>{t("wizard.install.body")}</p>
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          {t("wizard.back")}
        </button>
        <button type="button" onClick={onNext}>
          {t("wizard.next")}
        </button>
      </div>
    </>
  );
}

export interface SampleScreenProps {
  /** True while the end of the wizard is being saved. */
  busy: boolean;
  failure: ApiFailure | null;
  onBack: () => void;
  onFinish: () => void;
}

export function SampleScreen(props: SampleScreenProps) {
  return (
    <>
      <Heading>{t("wizard.sample.title")}</Heading>
      <p>{t("wizard.sample.body")}</p>
      <p>
        <a href="#/sample">{t("wizard.sample.link")}</a>
      </p>
      {props.failure && <ErrorMessage failure={props.failure} />}
      <div className="actions">
        <button type="button" className="secondary" onClick={props.onBack}>
          {t("wizard.back")}
        </button>
        <button type="button" disabled={props.busy} onClick={props.onFinish}>
          {t("wizard.sample.finish")}
        </button>
      </div>
    </>
  );
}

function go(step: WizardStep): void {
  window.location.hash = wizardHash(step);
}

function neighbour(step: WizardStep, offset: number): WizardStep {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + offset] ?? step;
}

export function WizardPage({
  onAuthRequired,
  onCompleted,
}: {
  onAuthRequired: () => void;
  /** Called once the server has recorded that the wizard is done. */
  onCompleted: () => void;
}) {
  const step = useWizardStep();
  const [check, setCheck] = useState<MachineCheckData | null>(null);
  const [checkFailure, setCheckFailure] = useState<ApiFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [finishFailure, setFinishFailure] = useState<ApiFailure | null>(null);

  const fail = (error: unknown): ApiFailure => {
    const failure = asApiFailure(error);
    if (failure.code === "auth.passphrase_required") onAuthRequired();
    return failure;
  };

  useEffect(() => {
    let current = true;
    api<MachineCheckData>("GET", "/api/machine-check").then(
      (view) => {
        if (current) setCheck(view);
      },
      (error: unknown) => {
        if (current) setCheckFailure(fail(error));
      },
    );
    return () => {
      current = false;
    };
    // The check loads once; the callback it uses is re-created on every render.
  }, []);

  // A new screen is a new page for a keyboard or screen reader user: move focus to its heading.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById("wizard-title")?.focus();
  }, [step]);

  const checkAgain = async () => {
    setChecking(true);
    setAnnouncement("");
    setCheckFailure(null);
    try {
      setCheck(await api<MachineCheckData>("POST", "/api/machine-check"));
      setAnnouncement(t("wizard.check.checked_again"));
    } catch (error) {
      setCheckFailure(fail(error));
    } finally {
      setChecking(false);
    }
  };

  const finish = async () => {
    setFinishing(true);
    setFinishFailure(null);
    try {
      const body: WizardUpdateRequest = { completed: true };
      await api<WizardView>("PUT", "/api/wizard", body);
      onCompleted();
      window.location.hash = "#/";
    } catch (error) {
      setFinishFailure(fail(error));
    } finally {
      setFinishing(false);
    }
  };

  const back = () => go(neighbour(step, -1));
  const next = () => go(neighbour(step, 1));

  return (
    <>
      <StepIndicator step={step} />
      {step === "welcome" ? (
        <WelcomeScreen onNext={next} />
      ) : step === "check" ? (
        <MachineCheckScreen
          check={check}
          failure={checkFailure}
          checking={checking}
          announcement={announcement}
          onCheckAgain={() => void checkAgain()}
          onBack={back}
          onNext={next}
        />
      ) : step === "engine" ? (
        <EngineChoiceScreen
          check={check}
          busy={finishing}
          failure={finishFailure}
          onInstall={next}
          onUiOnly={() => void finish()}
          onBack={back}
        />
      ) : step === "install" ? (
        <InstallScreen onBack={back} onNext={next} />
      ) : (
        <SampleScreen busy={finishing} failure={finishFailure} onBack={back} onFinish={() => void finish()} />
      )}
    </>
  );
}
