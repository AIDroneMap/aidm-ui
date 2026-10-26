import { useEffect, useState } from "react";
import { api, asApiFailure, type ApiFailure } from "./api.ts";
import { ErrorMessage } from "./components/ErrorMessage.tsx";
import { Layout } from "./components/Layout.tsx";
import { t } from "./i18n/translate.ts";
import { EnginesPage } from "./pages/EnginesPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { SampleJobPage } from "./pages/SampleJobPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { useRoute } from "./router.ts";
import type { SessionView } from "../../shared/api-types.ts";

type Session = "loading" | "login" | "ready";

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session>("loading");
  const [failure, setFailure] = useState<ApiFailure | null>(null);

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

  if (session === "login") return <LoginPage onSignedIn={() => setSession("ready")} />;
  if (session === "loading") {
    return <main>{failure ? <ErrorMessage failure={failure} /> : <p>{t("app.loading")}</p>}</main>;
  }
  return (
    <Layout route={route}>
      {route === "settings" ? (
        <SettingsPage onAuthRequired={() => setSession("login")} />
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
