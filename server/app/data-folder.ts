import path from "node:path";

export const DATA_FOLDER_ENV = "AIDM_UI_DATA_DIR";

export interface DataFolderInputs {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
  cwd: string;
  /** Value of --data-dir. */
  flag?: string;
}

const FOLDER_NAME = "aidm-ui";

/** Flag first, then the environment variable, then the platform convention. */
export function resolveDataFolder(inputs: DataFolderInputs): string {
  // path.win32 on win32 and path.posix elsewhere, so tests on any host can check both.
  const p = inputs.platform === "win32" ? path.win32 : path.posix;
  const { env, homeDir } = inputs;

  const explicit = inputs.flag || env[DATA_FOLDER_ENV];
  if (explicit) return p.resolve(inputs.cwd, explicit);

  switch (inputs.platform) {
    case "darwin":
      return p.join(homeDir, "Library", "Application Support", FOLDER_NAME);
    case "win32": {
      const local = env.LOCALAPPDATA;
      return local ? p.join(local, FOLDER_NAME) : p.join(homeDir, "AppData", "Local", FOLDER_NAME);
    }
    default: {
      // The XDG spec says a relative value must be ignored.
      const xdg = env.XDG_DATA_HOME;
      if (xdg && p.isAbsolute(xdg)) return p.join(xdg, FOLDER_NAME);
      return p.join(homeDir, ".local", "share", FOLDER_NAME);
    }
  }
}
