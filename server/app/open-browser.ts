/** Opens the browser at the address. A line about it goes to `log`, the diagnosis log once it is open. */
export type OpenBrowser = (url: string, log: (line: string) => void) => Promise<void>;

export function openerCommand(platform: NodeJS.Platform, url: string): string[] {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      // The empty string is the window title that `start` would otherwise take from the URL.
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

/** Opens the default browser. A failure is logged and never thrown: the server keeps running without a browser. */
export function platformOpener(platform: NodeJS.Platform): OpenBrowser {
  return async (url, log) => {
    try {
      const child = Bun.spawn(openerCommand(platform, url), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      child.unref();
    } catch {
      log(`Could not open a browser. Open ${url} yourself.`);
    }
  };
}
