import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests run the real shell scripts with stand-ins for the Mac tools on
// PATH. The stand-in xcrun answers from the step files of a scenario, one line
// per call, and keeps the last line for every call after that. A step is a
// JSON line, "empty" (no output), "fail <message>" (exit 1 with a message),
// "failjson <json>" (the JSON, then exit 1), or "hang" (runs until killed).

const HELPER = join(import.meta.dir, "ci/notary-wait.sh");
const PACKAGE = join(import.meta.dir, "ci/package-macos.sh");
const RECOVERY = "The maintainer can run the release workflow again from the same tag once Apple has accepted the submission.";
const ID = "abc-123";
const SUBMITTED = `{"id":"${ID}","message":"Successfully uploaded file"}`;
const IN_PROGRESS = `{"id":"${ID}","status":"In Progress"}`;
const ACCEPTED = `{"id":"${ID}","status":"Accepted"}`;
const INVALID = `{"id":"${ID}","status":"Invalid"}`;
const LOG = `{"issues":[{"message":"The signature of the binary is invalid."}]}`;
const NOTARY_KEY = "dummy-notary-key-contents";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const XCRUN = `#!/bin/sh
echo "$*" >> "$STUB/calls"
answer() {
  n=$(( $(cat "$STUB/$1.count" 2> /dev/null || echo 0) + 1 ))
  echo "$n" > "$STUB/$1.count"
  line="$(sed -n "\${n}p" "$STUB/$1.steps" 2> /dev/null)"
  [ -n "$line" ] || line="$(tail -n 1 "$STUB/$1.steps" 2> /dev/null)"
  case "$line" in
    empty) ;;
    hang) echo "$$" >> "$STUB/hung"; exec sleep 600 ;;
    "fail "*) echo "Error: \${line#fail }" >&2; exit 1 ;;
    "failjson "*) printf '%s\\n' "\${line#failjson }"; exit 1 ;;
    *) printf '%s\\n' "$line" ;;
  esac
}
case "$1 $2" in
  "notarytool submit") answer submit ;;
  "notarytool info") answer info ;;
  "notarytool log") answer log ;;
  "stapler staple" | "stapler validate") ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;

// Reads the flat string values of a JSON object, and fails on anything else, as plutil does.
const PLUTIL = `#!/bin/sh
[ "$1" = -extract ] && [ "$3" = raw ] || exit 64
content="$(cat "$4")"
case "$content" in "{"*"}") ;; *) echo "not a property list" >&2; exit 1 ;; esac
value="$(printf '%s' "$content" | sed -n "s/.*\\"$2\\" *: *\\"\\([^\\"]*\\)\\".*/\\1/p")"
[ -n "$value" ] || exit 1
printf '%s\\n' "$value"
`;

const SECURITY = `#!/bin/sh
echo "security $1" >> "$STUB/calls"
for last; do :; done
case "$1" in
  create-keychain) : > "$last" ;;
  find-identity) echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Test Org (TEST000000)"' ;;
  list-keychains) echo '    "/tmp/login.keychain-db"' ;;
esac
`;

const HDIUTIL = `#!/bin/sh
echo "hdiutil $1" >> "$STUB/calls"
for last; do :; done
case "$1" in
  create) : > "$last" ;;
  attach)
    while [ $# -gt 0 ]; do
      if [ "$1" = -mountpoint ]; then mount="$2"; fi
      shift
    done
    mkdir "$mount/AIDM UI.app"
    ln -s /Applications "$mount/Applications"
    ;;
  detach) rm -rf "$last"/* ;;
esac
`;

const SPCTL = `#!/bin/sh
echo "$3: accepted"
echo "source=Notarized Developer ID"
`;

interface Scene {
  dir: string;
  bin: string;
  state: string;
  tmp: string;
}

function script(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), "aidm-ui-notary-"));
  folders.push(dir);
  const [bin, state, tmp] = ["bin", "state", "tmp"].map((name) => join(dir, name)) as [string, string, string];
  for (const path of [bin, state, tmp]) mkdirSync(path);
  const realSleep = Bun.which("sleep") ?? "/bin/sleep";
  // Records the pid of every sleep, so a test can see that none is left behind.
  script(join(bin, "sleep"), `#!/bin/sh\necho "$$" >> "$STUB/sleeps"\nexec ${realSleep} "$@"\n`);
  script(join(bin, "xcrun"), XCRUN);
  script(join(bin, "plutil"), PLUTIL);
  script(join(bin, "security"), SECURITY);
  script(join(bin, "hdiutil"), HDIUTIL);
  script(join(bin, "spctl"), SPCTL);
  script(join(bin, "uuidgen"), "#!/bin/sh\necho 00000000-0000-0000-0000-000000000000\n");
  script(join(bin, "ditto"), '#!/bin/sh\ncp -R "$1" "$2"\n');
  for (const name of ["codesign", "xattr"]) script(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB/calls"\n`);
  return { dir, bin, state, tmp };
}

function steps(s: Scene, verb: "submit" | "info" | "log", lines: string[]): void {
  writeFileSync(join(s.state, `${verb}.steps`), `${lines.join("\n")}\n`);
}

function env(s: Scene, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), PATH: `${s.bin}:${process.env.PATH}`, STUB: s.state, TMPDIR: s.tmp, ...extra };
}

interface Outcome {
  code: number;
  output: string;
  seconds: number;
}

async function run(command: string[], environment: Record<string, string>): Promise<Outcome> {
  const started = Date.now();
  const child = Bun.spawn(command, { cwd: "/", env: environment, stdout: "pipe", stderr: "pipe" });
  // Reading both pipes to the end proves that no process the script started still holds them.
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: out + err, seconds: (Date.now() - started) / 1000 };
}

/** Runs notarize_dmg with the stand-in xcrun, a budget in seconds from now and a poll interval. */
function notarize(s: Scene, budget: number, interval = 0, requestSeconds = 60): Promise<Outcome> {
  const call = 'source "$1"; NOTARY_REQUEST_SECONDS="$6"; notarize_dmg "$2" "$3" "$((SECONDS + $4))" "$5" xcrun notarytool';
  return run(["bash", "-c", call, "bash", HELPER, join(s.dir, "image.dmg"), join(s.dir, "notary.json"), String(budget), String(interval), String(requestSeconds)], env(s));
}

function calls(s: Scene, verb?: string): string[] {
  const file = join(s.state, "calls");
  const all = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return verb ? all.filter((line) => line.startsWith(`notarytool ${verb} `)) : all;
}

function pids(s: Scene, name: "hung" | "sleeps"): number[] {
  const file = join(s.state, name);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
}

function isRunning(pid: number): boolean {
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return state !== "" && !state.startsWith("Z");
}

function expectNothingLeftRunning(s: Scene): void {
  for (const pid of [...pids(s, "hung"), ...pids(s, "sleeps")]) expect(isRunning(pid), `pid ${pid} is still running`).toBe(false);
}

test("an Accepted answer to the upload succeeds without asking again and without --wait", async () => {
  const s = scene();
  steps(s, "submit", [`{"id":"${ID}","status":"Accepted"}`]);
  const result = await notarize(s, 30);
  expect(result.code).toBe(0);
  expect(calls(s, "submit")).toEqual([`notarytool submit ${join(s.dir, "image.dmg")} --output-format json`]);
  expect(calls(s, "info")).toEqual([]);
  expect(calls(s).join("\n")).not.toContain("--wait");
});

test("a failed status request, then In Progress, then Accepted, succeeds", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", ["fail The request timed out.", IN_PROGRESS, ACCEPTED]);
  const result = await notarize(s, 30);
  expect(result.code).toBe(0);
  expect(calls(s, "info")).toHaveLength(3);
  for (const call of calls(s, "info")) expect(call).toBe(`notarytool info ${ID} --output-format json`);
  expect(result.output).toContain(`Submission id: ${ID}`);
  expect(result.output).toContain("Asking for the status ended with exit code 1.");
  expect(result.output).toContain("Notarization status: In Progress");
  expect(calls(s, "log")).toEqual([]);
  expectNothingLeftRunning(s);
});

test("an Accepted answer from a request that failed is not a verdict", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [`failjson ${ACCEPTED}`, IN_PROGRESS]);
  const result = await notarize(s, 2);
  expect(result.code).toBe(1);
  expect(result.output).toContain(RECOVERY);
  expect(result.output).not.toContain("Notarization ended");
});

test("an Invalid answer fetches the notary log, shows it and fails", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [IN_PROGRESS, INVALID]);
  steps(s, "log", [LOG]);
  const result = await notarize(s, 30);
  expect(result.code).toBe(1);
  expect(calls(s, "log")).toEqual([`notarytool log ${ID}`]);
  expect(result.output).toContain("The signature of the binary is invalid.");
  expect(result.output).toContain("::error::Notarization ended with status 'Invalid'.");
  expect(result.output).not.toContain(RECOVERY);
});

test("an Invalid answer to the upload fetches the log without asking for the status", async () => {
  const s = scene();
  steps(s, "submit", [INVALID]);
  steps(s, "log", [LOG]);
  const result = await notarize(s, 30);
  expect(result.code).toBe(1);
  expect(calls(s, "info")).toEqual([]);
  expect(calls(s, "log")).toHaveLength(1);
  expect(result.output).toContain("The signature of the binary is invalid.");
});

test("a notary log that cannot be fetched still fails the run, and says so", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [INVALID]);
  steps(s, "log", ["fail No log yet."]);
  const result = await notarize(s, 30);
  expect(result.code).toBe(1);
  expect(result.output).toContain(`The notary log of submission ${ID} could not be fetched (exit code 1).`);
  expect(result.output).toContain("::error::Notarization ended with status 'Invalid'.");
});

for (const [name, lines] of [
  ["an accepted answer without an id", [`{"status":"Accepted"}`]],
  ["no id in the answer", [`{"message":"Nothing was uploaded."}`]],
  ["an answer that is not JSON", ["Error: the key was refused."]],
  ["no answer at all", ["empty"]],
  ["a failed upload", ["fail The network is down."]],
] as const) {
  test(`${name} to the upload fails at once, without asking for a status`, async () => {
    const s = scene();
    steps(s, "submit", [...lines]);
    steps(s, "info", [ACCEPTED]);
    const result = await notarize(s, 30, 30);
    expect(result.code).toBe(1);
    expect(calls(s, "info")).toEqual([]);
    expect(calls(s, "log")).toEqual([]);
    expect(result.output).toContain("::error::The upload returned no submission id");
    expect(result.seconds).toBeLessThan(5);
  });
}

test("an upload that hangs is killed when the budget ends", async () => {
  const s = scene();
  steps(s, "submit", ["hang"]);
  const result = await notarize(s, 2);
  expect(result.code).toBe(1);
  expect(result.output).toContain("::error::The upload returned no submission id (exit code 124).");
  expect(calls(s, "info")).toEqual([]);
  expect(result.seconds).toBeLessThan(10);
  expect(pids(s, "hung")).toHaveLength(1);
  expectNothingLeftRunning(s);
});

test("a budget with no time left asks Apple for nothing", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  const result = await notarize(s, 0);
  expect(result.code).toBe(1);
  expect(calls(s)).toEqual([]);
});

test("when the budget ends the submission id and the way to recover are printed, and the run fails", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [IN_PROGRESS]);
  // The interval is longer than the budget: the wait must stop at the budget.
  const result = await notarize(s, 2, 30);
  expect(result.code).toBe(1);
  expect(result.output).toContain(`Submission id: ${ID}`);
  expect(result.output).toContain(`Apple had not finished before the time limit. Submission id: ${ID}`);
  expect(result.output.split("\n")).toContain(RECOVERY);
  expect(calls(s, "info").length).toBeGreaterThanOrEqual(1);
  expect(calls(s, "log")).toEqual([]);
  expect(result.seconds).toBeGreaterThanOrEqual(1.5);
  expect(result.seconds).toBeLessThan(10);
  expectNothingLeftRunning(s);
});

test("a status request that hangs is killed when the budget ends", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", ["hang"]);
  // The request limit is a full minute, so only the budget can stop it.
  const result = await notarize(s, 2);
  expect(result.code).toBe(1);
  expect(result.output).toContain("Asking for the status ended with exit code 124.");
  expect(result.output.split("\n")).toContain(RECOVERY);
  expect(result.output).toContain(ID);
  expect(pids(s, "hung")).toHaveLength(1);
  expect(result.seconds).toBeLessThan(10);
  expectNothingLeftRunning(s);
});

test("a status request that hangs is killed at its own limit and asked again", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", ["hang", ACCEPTED]);
  const result = await notarize(s, 60, 0, 1);
  expect(result.code).toBe(0);
  expect(calls(s, "info")).toHaveLength(2);
  expect(result.output).toContain("Asking for the status ended with exit code 124.");
  expect(result.seconds).toBeLessThan(10);
  expectNothingLeftRunning(s);
});

test("an answer that is empty, not JSON, without a status or unknown is asked for again", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", ["empty", "<html>Bad gateway</html>", `{"id":"${ID}"}`, `{"id":"${ID}","status":"Surprise"}`, `{"id":"${ID},"status":"Acc`, ACCEPTED]);
  const result = await notarize(s, 30);
  expect(result.code).toBe(0);
  expect(calls(s, "info")).toHaveLength(6);
  expect(result.output).toContain("Notarization status: unknown");
  expect(result.output).toContain("Notarization status: Surprise");
});

test("a fast answer returns at once: the watchdog and its sleep are cancelled", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [ACCEPTED]);
  const result = await notarize(s, 600, 30);
  expect(result.code).toBe(0);
  expect(result.seconds).toBeLessThan(5);
  // One watchdog sleep for the upload and one for the status request.
  expect(pids(s, "sleeps")).toHaveLength(2);
  expectNothingLeftRunning(s);
});

test("the poll interval is kept between requests", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [IN_PROGRESS, ACCEPTED]);
  const result = await notarize(s, 60, 1);
  expect(result.code).toBe(0);
  expect(result.seconds).toBeGreaterThanOrEqual(1);
  expect(result.seconds).toBeLessThan(10);
});

// The packaging script, run for real with stand-ins for the Mac tools.

function app(s: Scene): string {
  const path = join(s.dir, "AIDM UI.app");
  mkdirSync(join(path, "Contents/MacOS"), { recursive: true });
  script(join(path, "Contents/MacOS/aidm-ui"), "#!/bin/sh\n");
  return path;
}

function signing(): Record<string, string> {
  const encode = (text: string) => Buffer.from(text).toString("base64");
  return {
    MACOS_SIGNING_CERTIFICATE: encode("dummy-certificate"),
    MACOS_SIGNING_CERTIFICATE_PASSWORD: "dummy-password",
    MACOS_NOTARY_KEY: encode(NOTARY_KEY),
    MACOS_NOTARY_KEY_ID: "DUMMYKEYID",
    MACOS_NOTARY_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  };
}

/** The script waits 30 seconds between status requests: skips that wait, and keeps the watchdog's longer sleeps. */
function skipPollingPause(s: Scene): void {
  const realSleep = Bun.which("sleep") ?? "/bin/sleep";
  script(join(s.bin, "sleep"), `#!/bin/sh\n[ "$1" = 30 ] && exit 0\nexec ${realSleep} "$@"\n`);
}

async function packageApp(s: Scene): Promise<Outcome> {
  return run(["bash", PACKAGE, app(s), "1.2.3", join(s.dir, "out")], env(s, signing()));
}

test("the packaging script staples and validates the image once a status request says Accepted", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [ACCEPTED]);
  const result = await packageApp(s);
  expect(result.code, result.output).toBe(0);
  const all = calls(s);
  const [submit, info, staple, validate] = ["notarytool submit ", `notarytool info ${ID} `, "stapler staple ", "stapler validate "].map((start) =>
    all.findIndex((line) => line.startsWith(start)),
  );
  expect(submit).toBeGreaterThanOrEqual(0);
  expect(info).toBeGreaterThan(submit as number);
  expect(staple).toBeGreaterThan(info as number);
  expect(validate).toBeGreaterThan(staple as number);
  expect(all.join("\n")).not.toContain("--wait");
  // Every request carries the credentials as arguments, the key as a path.
  for (const call of calls(s, "submit").concat(calls(s, "info"))) expect(call).toContain("--key-id DUMMYKEYID --issuer 00000000-0000-0000-0000-000000000000");
  expect(result.output).toContain("Gatekeeper: ");
  expect(result.output).toContain("Packaged ");
  expect(readFileSync(join(s.dir, "out/mac-signing"), "utf8")).toBe("signed\n");
  expect(existsSync(join(s.dir, "out/aidm-ui-1.2.3-mac-apple-silicon.dmg"))).toBe(true);
  expect(result.output).not.toContain(NOTARY_KEY);
  expect(readdirSync(s.tmp)).toEqual([]);
});

test("the packaging script asks again after a failed status request, then staples", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", ["fail The request timed out.", ACCEPTED]);
  skipPollingPause(s);
  const result = await packageApp(s);
  expect(result.code, result.output).toBe(0);
  expect(calls(s, "info")).toHaveLength(2);
  expect(calls(s).some((line) => line.startsWith("stapler staple "))).toBe(true);
});

test("the packaging script fetches the notary log on Invalid and stops before stapling", async () => {
  const s = scene();
  steps(s, "submit", [SUBMITTED]);
  steps(s, "info", [IN_PROGRESS, INVALID]);
  steps(s, "log", [LOG]);
  skipPollingPause(s);
  const result = await packageApp(s);
  expect(result.code).toBe(1);
  expect(calls(s, "log")).toHaveLength(1);
  expect(calls(s, "log")[0]).toContain(`notarytool log ${ID} --key `);
  expect(result.output).toContain("The signature of the binary is invalid.");
  expect(result.output).toContain("::error::Notarization ended with status 'Invalid'.");
  expect(calls(s).some((line) => line.startsWith("stapler"))).toBe(false);
  expect(existsSync(join(s.dir, "out/mac-signing"))).toBe(false);
  expect(result.output).not.toContain(NOTARY_KEY);
  expect(readdirSync(s.tmp)).toEqual([]);
});
