/**
 * Splits a Windows command line into its arguments, by the rules the C
 * runtime of a Windows program uses to build its argv, so that a quoted path
 * with a space comes back as one argument without its quotes.
 *
 * - Spaces and tabs outside quotes end an argument.
 * - A quote starts or ends a quoted part, and is dropped.
 * - Backslashes before a quote: each pair gives one backslash. An odd one
 *   left over makes the quote a plain character.
 * - Backslashes anywhere else are plain characters, so `C:\work\` stays as it is.
 * - Two quotes inside a quoted part give one quote, and the part goes on.
 *
 * The first argument, the program, follows the system's simpler rule: it
 * runs to the next quote when it starts with one, or to the first space, and
 * backslashes in it are plain characters.
 */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  const text = commandLine;
  let at = 0;
  const isBlank = (char: string | undefined) => char === " " || char === "\t";

  // The program.
  if (text[at] === '"') {
    const end = text.indexOf('"', at + 1);
    args.push(end === -1 ? text.slice(at + 1) : text.slice(at + 1, end));
    at = end === -1 ? text.length : end + 1;
  } else {
    let end = at;
    while (end < text.length && !isBlank(text[end])) end++;
    if (end > at) args.push(text.slice(at, end));
    at = end;
  }

  for (;;) {
    while (isBlank(text[at])) at++;
    if (at >= text.length) return args;
    let arg = "";
    let quoted = false;
    while (at < text.length && (quoted || !isBlank(text[at]))) {
      const char = text[at] as string;
      if (char === "\\") {
        let count = 0;
        while (text[at] === "\\") {
          count++;
          at++;
        }
        if (text[at] === '"') {
          arg += "\\".repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            arg += '"';
            at++;
          }
        } else {
          arg += "\\".repeat(count);
        }
      } else if (char === '"') {
        if (quoted && text[at + 1] === '"') {
          arg += '"';
          at += 2;
        } else {
          quoted = !quoted;
          at++;
        }
      } else {
        arg += char;
        at++;
      }
    }
    args.push(arg);
  }
}
