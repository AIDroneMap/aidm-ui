import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "aidm_session";
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * Sign-ins from other computers on the local network. Kept in memory only:
 * a restart ends them all and the tablet signs in again.
 */
export class Sessions {
  private readonly expires = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  create(): string {
    const token = randomBytes(32).toString("base64url");
    this.expires.set(token, this.now() + LIFETIME_SECONDS * 1000);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const expiry = this.expires.get(token);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.expires.delete(token);
      return false;
    }
    return true;
  }

  fromRequest(req: Request): string | undefined {
    const header = req.headers.get("cookie");
    if (header === null) return undefined;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1) continue;
      if (part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim();
    }
    return undefined;
  }

  /** Ends every session, for when the LAN switch is turned off or the passphrase changes. */
  clear(): void {
    this.expires.clear();
  }

  cookieFor(token: string): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIFETIME_SECONDS}`;
  }
}
