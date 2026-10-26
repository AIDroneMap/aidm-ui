import { useSyncExternalStore } from "react";

export type Route = "home" | "settings";

export function routeFromHash(hash: string): Route {
  return hash === "#/settings" ? "settings" : "home";
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
