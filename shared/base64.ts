// The one place that turns bytes into standard base64 text and back, for the
// manifest code, the signing script and the test helpers.

/** Standard base64 of the bytes. It works on any length, with no spread of the array. */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    text += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(text);
}

/** Decodes standard base64 text, ignoring white space around it. Throws when the text is not base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.trim()), (char) => char.charCodeAt(0));
}
