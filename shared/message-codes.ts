// Every message code the server may send to the browser. The interface turns
// each one into text through web/src/i18n/en.json; a test checks that every
// code here has a translation.
export const MESSAGE_CODES = [
  "api.not_found",
  "api.method_not_allowed",
  "api.invalid_body",
  "server.internal_error",
  "interface.not_found",
  "interface.not_built",
  "auth.lan_disabled",
  "auth.host_not_allowed",
  "auth.origin_not_allowed",
  "auth.passphrase_required",
  "auth.passphrase_wrong",
  "auth.too_many_attempts",
  "settings.port_invalid",
  "settings.passphrase_too_short",
] as const;

export type MessageCode = (typeof MESSAGE_CODES)[number];
