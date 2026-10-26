import type { Route } from "./router.ts";

/**
 * Decides once per page load whether to send the operator to the wizard. It
 * does so only if the wizard is not done and the page opened on the home page.
 * After that the answer is always no, so leaving the wizard is never a trap.
 * Asked before the server has said whether the wizard is done (null), it
 * says no and waits.
 */
export function firstRunRedirect(): (route: Route, wizardDone: boolean | null) => boolean {
  let decided = false;
  return (route, wizardDone) => {
    if (wizardDone === null || decided) return false;
    decided = true;
    return route === "home" && !wizardDone;
  };
}
