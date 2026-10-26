// Shapes of the JSON the server and the interface exchange.

export interface SettingsView {
  /** The port the server tries first on its next start; null means the default, 8823. */
  port: number | null;
  /** The port the server listens on now. */
  listeningPort: number;
  lan: {
    enabled: boolean;
    /** IPv4 addresses of this computer on the local network, for typing on a tablet. */
    addresses: string[];
  };
}

/** PUT /api/settings/port */
export interface PortSettingRequest {
  port: number | null;
}

/** PUT /api/settings/lan */
export type LanSettingRequest = { enabled: true; passphrase: string } | { enabled: false };

/** POST /api/auth/login */
export interface LoginRequest {
  passphrase: string;
}

/** GET /api/auth/session */
export interface SessionView {
  /** True when this browser must enter the passphrase before using the interface. */
  passphraseRequired: boolean;
}

/** The port the server tries first when neither --port nor the setting names one. */
export const DEFAULT_PORT = 8823;
export const PASSPHRASE_MIN_LENGTH = 8;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
