import { useSyncExternalStore } from "react";

export type Route = "home" | "engines" | "sample" | "settings";

export function routeFromHash(hash: string): Route {
  if (hash === "#/settings") return "settings";
  if (hash === "#/sample") return "sample";
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
