import { useEffect, useState } from "react";
import { api } from "./api.ts";

/**
 * The version of this build of the page. Vite puts package.json's version in
 * at build time. Tests run without Vite and see a fixed value.
 */
export const PAGE_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-test";

/** How often the page asks the server which build it is. */
export const VERSION_CHECK_MS = 30_000;

/**
 * What tells one build from another: the version, and the hashed name of the
 * entry script, which Vite changes whenever the interface's code changes.
 * Builds made between two releases share a version, so the name is what tells
 * them apart. Null where there is no built page (tests, the development server).
 */
export interface BuildStamp {
  version: string;
  entry: string | null;
}

/** The entry script this page was loaded with, from its own index.html. */
export function pageEntry(doc: Pick<Document, "querySelector"> | undefined = globalThis.document): string | null {
  return doc?.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute("src") ?? null;
}

/** True when the server is another build than this page, so the page is out of date. */
export function pageIsStale(page: BuildStamp, server: BuildStamp | null): boolean {
  if (server === null) return false;
  if (server.version !== page.version) return true;
  return page.entry !== null && server.entry !== null && page.entry !== server.entry;
}

/**
 * Asks the server's health route which build it is. The route is open to
 * every computer, also before sign-in. Null when the server cannot be asked
 * or does not answer in the expected shape: a server that is away is not a new one.
 */
export async function readServerBuild(): Promise<BuildStamp | null> {
  try {
    const body = await api<{ version?: unknown; entry?: unknown }>("GET", "/api/health");
    if (typeof body.version !== "string") return null;
    return { version: body.version, entry: typeof body.entry === "string" ? body.entry : null };
  } catch {
    return null;
  }
}

/**
 * The build the server reports, now and every half minute, and again when
 * the operator comes back to the tab. A server that restarted as a newer
 * build is noticed at the next of these.
 */
export function useServerBuild(): BuildStamp | null {
  const [build, setBuild] = useState<BuildStamp | null>(null);
  useEffect(() => {
    let current = true;
    const check = () => {
      void readServerBuild().then((read) => {
        // A failed check keeps the last answer.
        if (current && read !== null) setBuild(read);
      });
    };
    check();
    const timer = setInterval(check, VERSION_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return build;
}
