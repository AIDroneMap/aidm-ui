import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeSystemFiles, RecordingRunner, exited } from "../../test-support/fake-privileged.ts";
import { recordedText } from "../../test-support/scripted-runner.ts";
import {
  OS_RELEASE_FILE,
  PASSWD_FILE,
  SAFE_PATH,
  SETUP_EXIT,
  SUBGID_FILE,
  SUBUID_FILE,
  chooseSubIdRange,
  installCommands,
  isValidUserName,
  packageManagerFor,
  parseOsRelease,
  runPodmanSetup,
  safeDistributionId,
  type PackageManager,
} from "./setup-command.ts";

const release = (name: string) => parseOsRelease(recordedText("os-release", name));

test.each<[string, string, string[], PackageManager | null]>([
  ["debian-13", "debian", [], "apt"],
  ["ubuntu-24.04", "ubuntu", ["debian"], "apt"],
  ["linuxmint-21.2", "linuxmint", ["ubuntu", "debian"], "apt"],
  ["fedora-42", "fedora", [], "dnf"],
  ["opensuse-tumbleweed", "opensuse-tumbleweed", ["opensuse", "suse"], "zypper"],
  ["arch", "arch", [], "pacman"],
  ["gentoo", "gentoo", [], null],
])("os-release %s: ID %s, ID_LIKE %p, package manager %p", (name, id, like, manager) => {
  expect(release(name)).toEqual({ id, idLike: like });
  expect(packageManagerFor(release(name))).toBe(manager);
});

test("a distribution is found by what it says it is like, and its own ID comes first", () => {
  expect(packageManagerFor(parseOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"\n'))).toBe("dnf");
  expect(packageManagerFor(parseOsRelease("ID=manjaro\nID_LIKE=arch\n"))).toBe("pacman");
  expect(packageManagerFor(parseOsRelease('ID=sles\nID_LIKE="suse"\n'))).toBe("zypper");
  expect(packageManagerFor(parseOsRelease("ID=pop\nID_LIKE='ubuntu debian'\n"))).toBe("apt");
  // An ID that is known wins over the one it is like.
  expect(packageManagerFor(parseOsRelease("ID=fedora\nID_LIKE=debian\n"))).toBe("dnf");
});

test("an os-release without an ID is linux, and comments and blank lines are skipped", () => {
  expect(parseOsRelease("# a comment\n\nNAME=Thing\n")).toEqual({ id: "linux", idLike: [] });
  expect(packageManagerFor(parseOsRelease("NAME=Thing\n"))).toBeNull();
});

test("the install commands are the ones of each package manager and name no other package", () => {
  expect(installCommands("apt")).toEqual([
    { argv: ["apt-get", "update"], env: { DEBIAN_FRONTEND: "noninteractive" }, optional: true },
    { argv: ["apt-get", "install", "-y", "podman"], env: { DEBIAN_FRONTEND: "noninteractive" } },
  ]);
  expect(installCommands("dnf")).toEqual([{ argv: ["dnf", "install", "-y", "podman"] }]);
  expect(installCommands("zypper")).toEqual([{ argv: ["zypper", "--non-interactive", "install", "podman"] }]);
  expect(installCommands("pacman")).toEqual([{ argv: ["pacman", "-S", "--noconfirm", "--needed", "podman"] }]);
  for (const manager of ["apt", "dnf", "zypper", "pacman"] as const) {
    for (const command of installCommands(manager)) expect(command.argv.join(" ").toLowerCase()).not.toContain("docker");
  }
});

test.each([
  ["alice", true],
  ["a", true],
  ["_svc", true],
  ["first.last", true],
  ["dev-1", true],
  ["User_9", true],
  ["", false],
  ["-rf", false],
  ["a b", false],
  ["a;b", false],
  ["a/b", false],
  ["a$(x)", false],
  ["na\nme", false],
  ["x".repeat(33), false],
])("user name %p is valid: %p", (name, valid) => {
  expect(isValidUserName(name)).toBe(valid);
});

test("the subordinate ID range starts at 100000 when the files hold nothing", () => {
  expect(chooseSubIdRange([null, null])).toEqual({ first: 100000, last: 165535 });
  expect(chooseSubIdRange(["", "# nothing\n"])).toEqual({ first: 100000, last: 165535 });
});

test("the range starts after the highest range already in either file", () => {
  expect(chooseSubIdRange(["bob:100000:65536\n", null])).toEqual({ first: 165536, last: 231071 });
  expect(chooseSubIdRange(["bob:100000:65536\n", "carol:300000:1000\nbob:100000:65536\n"])).toEqual({
    first: 301000,
    last: 366535,
  });
  // A range below 100000 does not move the start down.
  expect(chooseSubIdRange(["root:0:1000\nbad line\nx:y:z\n", null])).toEqual({ first: 100000, last: 165535 });
});

test("when the IDs have run out there is no range", () => {
  expect(chooseSubIdRange(["big:4294900000:60000\n"])).toBeNull();
});

const DEBIAN = { [OS_RELEASE_FILE]: recordedText("os-release", "debian-13") };

function run(files: FakeSystemFiles, runner = new RecordingRunner(), user = "alice") {
  const lines: string[] = [];
  const done = runPodmanSetup({ user, files, runner, print: (line) => lines.push(line) });
  return { done, lines, runner, files };
}

test("on Debian with no ranges the commands are the update, the install and the range change, in that order", async () => {
  const { done, runner, lines } = run(new FakeSystemFiles({ ...DEBIAN, [SUBUID_FILE]: "", [SUBGID_FILE]: "" }));
  expect(await done).toBe(SETUP_EXIT.done);
  expect(runner.argvs).toEqual([
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "podman"],
    ["usermod", "--add-subuids", "100000-165535", "--add-subgids", "100000-165535", "alice"],
  ]);
  expect(lines.length).toBeGreaterThanOrEqual(3);
});

test.each([
  ["fedora-42", [["dnf", "install", "-y", "podman"]]],
  ["opensuse-tumbleweed", [["zypper", "--non-interactive", "install", "podman"]]],
  ["arch", [["pacman", "-S", "--noconfirm", "--needed", "podman"]]],
])("on %s the package install is the one of its package manager", async (name, install) => {
  const files = new FakeSystemFiles({ [OS_RELEASE_FILE]: recordedText("os-release", name), [SUBUID_FILE]: "alice:100000:65536\n", [SUBGID_FILE]: "alice:100000:65536\n" });
  const { done, runner } = run(files);
  expect(await done).toBe(0);
  expect(runner.argvs).toEqual(install);
});

test("a user who has a range in both files gets no change; one missing from a single file gets only that one", async () => {
  const both = run(new FakeSystemFiles({ ...DEBIAN, [SUBUID_FILE]: "alice:100000:65536\n", [SUBGID_FILE]: "alice:100000:65536\n" }));
  expect(await both.done).toBe(0);
  expect(both.runner.argvs.some((argv) => argv[0] === "usermod")).toBe(false);

  const onlyGid = run(
    new FakeSystemFiles({ ...DEBIAN, [SUBUID_FILE]: "alice:100000:65536\n", [SUBGID_FILE]: "bob:100000:65536\n" }),
  );
  expect(await onlyGid.done).toBe(0);
  expect(onlyGid.runner.argvs.at(-1)).toEqual(["usermod", "--add-subgids", "165536-231071", "alice"]);
});

test("a missing ranges file counts as empty", async () => {
  const { done, runner } = run(new FakeSystemFiles(DEBIAN));
  expect(await done).toBe(0);
  expect(runner.argvs.at(-1)).toEqual(["usermod", "--add-subuids", "100000-165535", "--add-subgids", "100000-165535", "alice"]);
});

test("an unsupported distribution exits with 3 before running anything", async () => {
  const files = new FakeSystemFiles({ [OS_RELEASE_FILE]: recordedText("os-release", "gentoo") });
  const { done, runner } = run(files);
  expect(await done).toBe(SETUP_EXIT.unsupportedDistribution);
  expect(runner.calls).toEqual([]);
  expect(files.reads).toEqual([OS_RELEASE_FILE]);
});

test("a missing os-release is an unsupported distribution", async () => {
  const { done, runner } = run(new FakeSystemFiles({}));
  expect(await done).toBe(3);
  expect(runner.calls).toEqual([]);
});

test("a package manager that fails exits with 4 and the ranges are not touched", async () => {
  const runner = new RecordingRunner((argv) => (argv[1] === "install" ? { exitCode: 100, stdout: "", stderr: "E: nope\n" } : exited(0)));
  const { done, lines } = run(new FakeSystemFiles(DEBIAN), runner);
  expect(await done).toBe(SETUP_EXIT.packageManagerFailed);
  expect(runner.argvs.map((argv) => argv[0])).toEqual(["apt-get", "apt-get"]);
  expect(lines.at(-1)).toContain("100");
});

test("a failing apt-get update does not stop the install", async () => {
  const runner = new RecordingRunner((argv) => (argv[1] === "update" ? exited(100) : exited(0)));
  const { done } = run(new FakeSystemFiles({ ...DEBIAN, [SUBUID_FILE]: "alice:100000:65536\n", [SUBGID_FILE]: "alice:100000:65536\n" }), runner);
  expect(await done).toBe(0);
  expect(runner.argvs).toEqual([
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "podman"],
  ]);
});

test("a usermod that fails exits with 5", async () => {
  const runner = new RecordingRunner((argv) => (argv[0] === "usermod" ? exited(6) : exited(0)));
  const { done } = run(new FakeSystemFiles(DEBIAN), runner);
  expect(await done).toBe(SETUP_EXIT.usermodFailed);
});

test("a user name with bad characters is refused with 2 before anything is read or run", async () => {
  for (const user of ["", "-rf", "a b", "a;rm", "$(id)"]) {
    const files = new FakeSystemFiles(DEBIAN);
    const { done, runner } = run(files, new RecordingRunner(), user);
    expect(await done).toBe(SETUP_EXIT.badArguments);
    expect(runner.calls).toEqual([]);
    expect(files.reads).toEqual([]);
  }
});

// Criterion: the setup subcommand reads nothing from the operator's data folder while running as root.
test("the setup command reads only os-release, the two ID range files and the user list", async () => {
  const files = new FakeSystemFiles({ ...DEBIAN, [SUBUID_FILE]: "", [SUBGID_FILE]: "" });
  const { done } = run(files);
  expect(await done).toBe(0);
  expect(new Set(files.reads)).toEqual(new Set([OS_RELEASE_FILE, SUBUID_FILE, SUBGID_FILE, PASSWD_FILE]));
});

test("the setup command takes only a user: its dependencies hold no data folder", () => {
  // The type of the dependencies is the proof; this keeps the source from growing a path parameter unnoticed.
  const source = readFileSync(import.meta.dir + "/setup-command.ts", "utf8");
  expect(source).not.toMatch(/dataFolder|data-dir|settings|database/i);
});

// The environment of the child commands.

test("every child command gets the fixed PATH and a minimal environment, never the inherited one", async () => {
  const { done, runner } = run(new FakeSystemFiles({ ...DEBIAN, [SUBUID_FILE]: "", [SUBGID_FILE]: "" }));
  expect(await done).toBe(0);
  expect(SAFE_PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  expect(runner.calls.map((call) => call.argv[0])).toEqual(["apt-get", "apt-get", "usermod"]);
  for (const call of runner.calls) expect(call.inheritEnv).toBe(false);
  expect(runner.calls[0]?.env).toEqual({ PATH: SAFE_PATH, LANG: "C", DEBIAN_FRONTEND: "noninteractive" });
  expect(runner.calls[1]?.env).toEqual({ PATH: SAFE_PATH, LANG: "C", DEBIAN_FRONTEND: "noninteractive" });
  expect(runner.calls[2]?.env).toEqual({ PATH: SAFE_PATH, LANG: "C" });
});

test("the other package managers get the same minimal environment, without the apt variable", async () => {
  const files = new FakeSystemFiles({
    [OS_RELEASE_FILE]: recordedText("os-release", "fedora-42"),
    [SUBUID_FILE]: "alice:100000:65536\n",
    [SUBGID_FILE]: "alice:100000:65536\n",
  });
  const { done, runner } = run(files);
  expect(await done).toBe(0);
  expect(runner.calls).toEqual([{ argv: ["dnf", "install", "-y", "podman"], env: { PATH: SAFE_PATH, LANG: "C" }, inheritEnv: false }]);
});

// Subordinate IDs named by user name or by number.

const PASSWD = "root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\n";

test("a line for the user's number counts, in either file, so no range is added", async () => {
  const files = new FakeSystemFiles({ ...DEBIAN, [PASSWD_FILE]: PASSWD, [SUBUID_FILE]: "1000:100000:65536\n", [SUBGID_FILE]: "1000:100000:65536\n" });
  const { done, runner } = run(files);
  expect(await done).toBe(0);
  expect(runner.argvs.some((argv) => argv[0] === "usermod")).toBe(false);
});

test("a line by number in one file and by name in the other also counts", async () => {
  const files = new FakeSystemFiles({ ...DEBIAN, [PASSWD_FILE]: PASSWD, [SUBUID_FILE]: "1000:100000:65536\n", [SUBGID_FILE]: "alice:100000:131072\n" });
  const { done, runner } = run(files);
  expect(await done).toBe(0);
  expect(runner.argvs.some((argv) => argv[0] === "usermod")).toBe(false);
});

test("a line with fewer than 65536 IDs does not count, by name or by number, so a range is added", async () => {
  const small = new FakeSystemFiles({ ...DEBIAN, [PASSWD_FILE]: PASSWD, [SUBUID_FILE]: "alice:100000:65535\n", [SUBGID_FILE]: "1000:100000:1000\n" });
  const { done, runner } = run(small);
  expect(await done).toBe(0);
  expect(runner.argvs.at(-1)).toEqual(["usermod", "--add-subuids", "165535-231070", "--add-subgids", "165535-231070", "alice"]);
});

test("a line by number does not count when the user list has no number for the user", async () => {
  const files = new FakeSystemFiles({ ...DEBIAN, [PASSWD_FILE]: "root:x:0:0:root:/root:/bin/bash\n", [SUBUID_FILE]: "1000:100000:65536\n", [SUBGID_FILE]: "1000:100000:65536\n" });
  const { done, runner } = run(files);
  expect(await done).toBe(0);
  expect(runner.argvs.at(-1)?.[0]).toBe("usermod");
});

test("a line for another user's number does not count", async () => {
  const files = new FakeSystemFiles({ ...DEBIAN, [PASSWD_FILE]: PASSWD, [SUBUID_FILE]: "1001:100000:65536\n", [SUBGID_FILE]: "1001:100000:65536\n" });
  const { done, runner } = run(files);
  expect(await done).toBe(0);
  expect(runner.argvs.at(-1)?.[0]).toBe("usermod");
});

// What leaves for the browser.

test.each([
  ["debian", "debian"],
  ["rocky-linux_9.3", "rocky-linux_9.3"],
  ["with space/and<tags>", "with_space_and_tags_"],
  ["x".repeat(100), "x".repeat(64)],
  ["\u00e9cole", "_cole"],
])("the distribution ID %p leaves as %p", (id, cleaned) => {
  expect(safeDistributionId(id)).toBe(cleaned);
});
