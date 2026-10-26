// A stand-in for the task API program of a native package, for tests. It is
// started the way the real one is (`--port`, `--token`, ...), answers like the
// fake task API, writes a line to its output when it starts, and ends on SIGTERM.
//
// AIDM_FAKE_VERSION sets the version it reports. AIDM_FAKE_SILENT=1 makes it
// run without listening on anything, like an engine that never gets ready.
import { FakeTaskApi } from "./fake-task-api.ts";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const port = Number(flag("--port") ?? 0);
const token = flag("--token") ?? "fake-token";
const version = process.env.AIDM_FAKE_VERSION ?? "2.5.0";

const api = process.env.AIDM_FAKE_SILENT === "1" ? undefined : new FakeTaskApi({ token, info: { version } });
await api?.start(port);

// The token is left out, as the real engine's log leaves it out of its lines.
const shown = args.map((part, index) => (args[index - 1] === "--token" ? "***" : part));
console.log(`fake native engine ${version} started in ${process.cwd()} with ${shown.join(" ")}`);

process.on("SIGTERM", () => {
  console.log("fake native engine stopping");
  void (api?.stop() ?? Promise.resolve()).then(() => process.exit(0));
});

// Keeps a silent engine alive.
setInterval(() => {}, 1 << 30);
