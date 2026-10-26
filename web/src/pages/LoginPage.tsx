import { useState, type FormEvent } from "react";
import { api, ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { t } from "../i18n/translate.ts";
import type { LoginRequest } from "../../../shared/api-types.ts";

export interface LoginViewProps {
  passphrase: string;
  onPassphraseChange: (value: string) => void;
  failure: ApiFailure | null;
  signingIn: boolean;
  onSubmit: () => void;
}

export function LoginView(props: LoginViewProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };
  return (
    <main>
      <h1>{t("login.title")}</h1>
      <p>{t("login.body")}</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="login-passphrase">{t("login.label")}</label>
          <input
            id="login-passphrase"
            type="password"
            autoComplete="current-password"
            required
            value={props.passphrase}
            onChange={(event) => props.onPassphraseChange(event.target.value)}
          />
        </div>
        {props.failure && <ErrorMessage failure={props.failure} />}
        <button type="submit" disabled={props.signingIn}>
          {props.signingIn ? t("login.working") : t("login.submit")}
        </button>
      </form>
    </main>
  );
}

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const submit = async () => {
    setSigningIn(true);
    setFailure(null);
    try {
      const request: LoginRequest = { passphrase };
      await api<void>("POST", "/api/auth/login", request);
      setPassphrase("");
      onSignedIn();
    } catch (error) {
      setFailure(error instanceof ApiFailure ? error : new ApiFailure(0, "server.internal_error"));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <LoginView
      passphrase={passphrase}
      onPassphraseChange={setPassphrase}
      failure={failure}
      signingIn={signingIn}
      onSubmit={() => void submit()}
    />
  );
}
