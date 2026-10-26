import { useSyncExternalStore } from "react";

export type Route = "home" | "engines" | "settings";

export function routeFromHash(hash: string): Route {
  if (hash === "#/settings") return "settings";
  return hash === "#/engines" ? "engines" : "home";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    subscribe,
    () => routeFromHash(window.location.hash),
    () => "home",
  );
}
