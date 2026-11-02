import { useEffect, useRef, useState } from "react";
import { api, asApiFailure, type ApiFailure } from "./api.ts";
import { ErrorMessage } from "./components/ErrorMessage.tsx";
import { VersionWatch } from "./components/VersionBanner.tsx";
import { firstRunRedirect } from "./firstRun.ts";
import { t } from "./i18n/translate.ts";
import { EnginesPage } from "./pages/EnginesPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { PreferencesPage } from "./pages/PreferencesPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { RunPage } from "./pages/RunPage.tsx";
import { WizardPage } from "./pages/WizardPage.tsx";
import { redirectFromHash, routeFromHash, SAMPLE_HASH, sectionHash, useHash, wizardHash } from "./router.ts";
import { ProjectScreen } from "./shell/ProjectScreen.tsx";
import { Shell } from "./shell/Shell.tsx";
import { useWorkspaceProject } from "./shell/useWorkspaceProject.ts";
import type { SampleView, SessionView, WizardView } from "../../shared/api-types.ts";

type Session = "loading" | "login" | "ready";

function Screens() {
  const hash = useHash();
  const route = routeFromHash(hash);
  const [session, setSession] = useState<Session>("loading");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // Null until the server says whether the first-run wizard is done.
  const [wizardDone, setWizardDone] = useState<boolean | null>(null);
  // The project of the open run, once the run has loaded, so the sidebar can show its sections.
  const [runProject, setRunProject] = useState<{ runId: number; projectId: number } | null>(null);
  const authRequired = () => setSession("login");

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

  // Saved links to old addresses keep working. Replacing the address keeps the old one out of the history.
  const moved = redirectFromHash(hash);
  useEffect(() => {
    if (moved !== null) window.location.replace(moved);
  }, [moved]);

  // The sample job page became the sample project's Runs section. Before its first run that project has no
  // workspace yet, so the address goes to the wizard step that offers the sample job.
  const sample = hash === SAMPLE_HASH;
  useEffect(() => {
    if (!sample || session !== "ready") return;
    let current = true;
    api<SampleView>("GET", "/api/sample").then(
      (view) => {
        if (current) window.location.replace(view.run ? sectionHash(view.run.projectId, "runs") : wizardHash("sample"));
      },
      () => {
        if (current) window.location.replace("#/");
      },
    );
    return () => {
      current = false;
    };
  }, [sample, session]);

  const projectId = route.screen === "project" ? route.projectId
    : route.screen === "run" && runProject?.runId === route.runId ? runProject.projectId : null;
  const workspace = useWorkspaceProject(session === "ready" ? projectId : null, authRequired, hash);

  // First run: a page that opens on the Projects screen goes to the wizard, once. After that the operator is free to leave.
  const redirect = useRef(firstRunRedirect());
  useEffect(() => {
    if (moved === null && !sample && redirect.current(route.screen, wizardDone)) window.location.replace(wizardHash("welcome"));
  }, [route.screen, wizardDone, moved, sample]);

  if (session === "login") return <LoginPage onSignedIn={() => setSession("ready")} />;
  if (session === "loading" || moved !== null || sample) {
    return <main>{failure ? <ErrorMessage failure={failure} /> : <p>{t("app.loading")}</p>}</main>;
  }
  if (route.screen === "wizard") {
    return <main><WizardPage onAuthRequired={authRequired} onCompleted={() => setWizardDone(true)} /></main>;
  }
  return (
    <Shell route={route} project={workspace.project} wide={route.screen === "project" && route.viewer !== undefined}>
      {route.screen === "project" ? (
        <ProjectScreen route={route} workspace={workspace} onAuthRequired={authRequired} />
      ) : route.screen === "run" ? (
        <RunPage key={route.runId} runId={String(route.runId)} onProject={(id) => setRunProject({ runId: route.runId, projectId: id })} onAuthRequired={authRequired} />
      ) : route.screen === "preferences" ? (
        <PreferencesPage onAuthRequired={authRequired} onWizardReopened={() => setWizardDone(false)} />
      ) : route.screen === "engines" ? (
        <EnginesPage onAuthRequired={authRequired} />
      ) : (
        <ProjectsPage onAuthRequired={authRequired} />
      )}
    </Shell>
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
