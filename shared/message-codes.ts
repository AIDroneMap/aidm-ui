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
  "settings.lan_local_only",
  "settings.port_invalid",
  "settings.passphrase_too_short",
  "engine.address_invalid",
  "engine.https_required",
  "engine.plain_http_local",
  "engine.unreachable",
  "engine.error",
  "engine.bad_response",
  "engine.unsupported_version",
  "engine.not_found",
  "engine.name_required",
] as const;

export type MessageCode = (typeof MESSAGE_CODES)[number];
