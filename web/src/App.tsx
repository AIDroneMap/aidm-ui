import { useEffect, useRef, useState } from "react";
import { api, asApiFailure, type ApiFailure } from "./api.ts";
import { ErrorMessage } from "./components/ErrorMessage.tsx";
import { Layout } from "./components/Layout.tsx";
import { VersionWatch } from "./components/VersionBanner.tsx";
import { firstRunRedirect } from "./firstRun.ts";
import { t } from "./i18n/translate.ts";
import { EnginesPage } from "./pages/EnginesPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { SampleJobPage } from "./pages/SampleJobPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { WizardPage } from "./pages/WizardPage.tsx";
import { useRoute } from "./router.ts";
import type { SessionView, WizardView } from "../../shared/api-types.ts";

type Session = "loading" | "login" | "ready";

function Screens() {
  const route = useRoute();
  const [session, setSession] = useState<Session>("loading");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // Null until the server says whether the first-run wizard is done.
  const [wizardDone, setWizardDone] = useState<boolean | null>(null);

  useEffect(() => {
    let current = true;
    api<SessionView>("GET", "/api/auth/session").then(
      (view) => {
        if (current) setSession(view.passphraseRequired ? "login" : "ready");
      },
      (error: unknown) => {
        if (current) setFailure(asApiFailure(error));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (session !== "ready") return;
    let current = true;
    api<WizardView>("GET", "/api/wizard").then(
      (view) => {
        if (current) setWizardDone(view.completed);
      },
      () => {
        // The wizard is a convenience: if its state cannot be read, the operator still gets the interface.
        if (current) setWizardDone(true);
      },
    );
    return () => {
      current = false;
    };
  }, [session]);

  // First run: a page that opens on the home page goes to the wizard, once. After that the operator is free to leave.
  const redirect = useRef(firstRunRedirect());
  useEffect(() => {
    if (redirect.current(route, wizardDone)) window.location.replace("#/wizard");
  }, [route, wizardDone]);

  if (session === "login") return <LoginPage onSignedIn={() => setSession("ready")} />;
  if (session === "loading") {
    return <main>{failure ? <ErrorMessage failure={failure} /> : <p>{t("app.loading")}</p>}</main>;
  }
  return (
    <Layout route={route}>
      {route === "wizard" ? (
        <WizardPage onAuthRequired={() => setSession("login")} onCompleted={() => setWizardDone(true)} />
      ) : route === "settings" ? (
        <SettingsPage onAuthRequired={() => setSession("login")} onWizardReopened={() => setWizardDone(false)} />
      ) : route === "engines" ? (
        <EnginesPage onAuthRequired={() => setSession("login")} />
      ) : route === "sample" ? (
        <SampleJobPage onAuthRequired={() => setSession("login")} />
      ) : (
        <HomePage />
      )}
    </Layout>
  );
}

export function App() {
  return (
    <>
      <VersionWatch />
      <Screens />
    </>
  );
}
