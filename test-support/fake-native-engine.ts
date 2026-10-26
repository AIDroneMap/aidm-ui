// A stand-in for the task API program of a native package, for tests. It is
// started the way the real one is, with its options in a JSON file given by
// `--config` (token, port, parallelQueueProcessing, odx_path) or as flags
// (`--port`, `--token`, ...); a flag wins over the file, as in aidm-api. It
// answers like the fake task API, writes a line to its output when it starts,
// and ends on SIGTERM.
//
// AIDM_FAKE_VERSION sets the version it reports. AIDM_FAKE_SILENT=1 makes it
// run without listening on anything, like an engine that never gets ready.
// AIDM_FAKE_IGNORE_TERM=1 makes it ignore SIGTERM. AIDM_FAKE_NOISE_LINES=n
// makes it print n lines after it starts, in small bursts. AIDM_FAKE_BAD_INFO=1
// makes the info route answer without a version, like an engine that is not
// well or is busy with something else.
import { readFileSync } from "node:fs";
import { FakeTaskApi } from "./fake-task-api.ts";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const configPath = flag("--config");
const fromFile: Record<string, unknown> = configPath === undefined ? {} : JSON.parse(readFileSync(configPath, "utf8"));

const port = Number(flag("--port") ?? fromFile.port ?? 0);
const token = flag("--token") ?? (typeof fromFile.token === "string" ? fromFile.token : "fake-token");
const version = process.env.AIDM_FAKE_VERSION ?? "2.5.0";

const api = process.env.AIDM_FAKE_SILENT === "1" ? undefined : new FakeTaskApi({ token, info: { version } });
if (api !== undefined && process.env.AIDM_FAKE_BAD_INFO === "1") api.info = {} as typeof api.info;
await api?.start(port);

// The token is left out, as the real engine's log leaves it out of its lines.
const shown = args.map((part, index) => (args[index - 1] === "--token" ? "***" : part));
console.log(`fake native engine ${version} started in ${process.cwd()} with ${shown.join(" ")}`);

if (process.env.AIDM_FAKE_IGNORE_TERM !== "1") {
  process.on("SIGTERM", () => {
    console.log("fake native engine stopping");
    void (api?.stop() ?? Promise.resolve()).then(() => process.exit(0));
  });
} else {
  process.on("SIGTERM", () => {
    console.log("fake native engine ignores SIGTERM");
  });
}

const noise = Number(process.env.AIDM_FAKE_NOISE_LINES ?? 0);
if (noise > 0) {
  let printed = 0;
  const burst = setInterval(() => {
    for (let n = 0; n < 50 && printed < noise; n++) console.log(`noise ${++printed} ${"x".repeat(90)}`);
    if (printed >= noise) {
      clearInterval(burst);
      console.log("fake native engine noise done");
    }
  }, 10);
}

// Keeps a silent engine alive.
setInterval(() => {}, 1 << 30);
