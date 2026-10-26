import type { Settings } from "../settings/settings.ts";
import { loopbackAuth, passphraseAuth, type AuthHook } from "./hook.ts";
import type { Sessions } from "./sessions.ts";

/** The hook for the moment: it follows the LAN switch, so ask again on every request. */
export function currentAuth(settings: Settings, sessions: Sessions): AuthHook {
  return settings.get("lan.enabled") ? passphraseAuth(sessions) : loopbackAuth();
}
