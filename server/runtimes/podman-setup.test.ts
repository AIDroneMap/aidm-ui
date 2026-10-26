import { afterEach, expect, test } from "bun:test";
import type { ApiError } from "../../shared/api-error.ts";
import type { LocalEngineView, MachineCheckView, RuntimeSetupView, SetupPhase } from "../../shared/api-types.ts";
import { FakePrivilegedRunner, FakeSystemFiles, RecordingRunner, exited } from "../../test-support/fake-privileged.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { linuxInputs, podmanRules, recordedMachine, type RecordedMachine } from "../../test-support/recorded-machine.ts";
import { ScriptedRunner, recordedText } from "../../test-support/scripted-runner.ts";
import { parseSetupCommand } from "../app/cli.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { pkexecRunner } from "./podman-setup.ts";
import type { CommandRunner, CommandStreamOptions } from "../process/command-runner.ts";
import { OS_RELEASE_FILE, PASSWD_FILE, SUBGID_FILE, SUBUID_FILE, runPodmanSetup } from "./setup-command.ts";

const open: Harness[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A Debian computer without a container tool, whose setup step runs in this process against fake files and a recording runner. */
function computer(options: { release?: string; works?: boolean } = {}) {
  const release = options.release ?? "debian-13";
  const rootFiles = new FakeSystemFiles({
    [OS_RELEASE_FILE]: recordedText("os-release", release),
    [SUBUID_FILE]: "",
    [SUBGID_FILE]: "",
  });
  // What the machine check sees; the setup step turns it on.
  const machine: RecordedMachine = recordedMachine(
    linuxInputs({ rules: options.works === true ? podmanRules("info-rootless") : [] }),
  );
  const podman = new FakeRuntime(
    options.works === true
      ? {}
      : { detection: { available: false, version: null, problem: { code: "runtime.not_installed", data: { runtime: "podman" } } } },
  );
  const rootRunner = new RecordingRunner();
  const operatorRunner = new ScriptedRunner([{ argv: ["podman", "system", "migrate"], result: exited(0) }]);
  let worksAfterSetup = true;
  const privileged = new FakePrivilegedRunner(async (argv, say) => {
    const parsed = parseSetupCommand(argv);
    if (parsed === null || !parsed.ok) return exited(2);
    const code = await runPodmanSetup({ user: parsed.user, files: rootFiles, runner: rootRunner, print: say });
    if (code === 0 && worksAfterSetup) {
      machine.inputs = linuxInputs({ rules: podmanRules("info-rootless") });
      podman.detection = { ...podman.detection, available: true, version: "5.8.9", problem: null };
    }
    return exited(code);
  });
  const operatorFiles = new FakeSystemFiles({ [OS_RELEASE_FILE]: recordedText("os-release", release) });
  const h = openHarness({
    enginePollMs: 50,
    machine,
    runtimes: { podman },
    setup: { privileged, files: operatorFiles, runner: operatorRunner, operator: "alice" },
  });
  open.push(h);
  return {
    h,
    machine,
    podman,
    privileged,
    rootFiles,
    rootRunner,
    operatorRunner,
    operatorFiles,
    /** The setup step succeeds but the tool still does not work. */
    staysBroken() {
      worksAfterSetup = false;
    },
  };
}

function post(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`, { method: "POST" });
}

const setupRuntime = (h: Harness) => post(h, "/api/local-engine/setup-runtime");

async function errorOf(response: Response): Promise<ApiError> {
  return ((await response.json()) as { error: ApiError }).error;
}

async function finished(h: Harness): Promise<RuntimeSetupView> {
  await h.runtimeSetup.settled();
  const view = h.runtimeSetup.view();
  if (view === null) throw new Error("The setup never began.");
  return view;
}

// Criterion: with a fake privileged runner, the wizard calls the setup subcommand once and the recorded commands are the package install and the subordinate-ID change only.
test("the wizard calls the setup command once, and it runs the package install and the ID range change only", async () => {
  const c = computer();
  const response = await setupRuntime(c.h);
  expect(response.status).toBe(202);
  await finished(c.h);

  expect(c.privileged.calls).toEqual([["setup-podman", "--user", "alice"]]);
  expect(c.rootRunner.argvs).toEqual([
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "podman"],
    ["usermod", "--add-subuids", "100000-165535", "--add-subgids", "100000-165535", "alice"],
  ]);
});

// Criterion: a dismissed prompt shows the message code and the remote-engine offer.
test("a dismissed prompt ends in setup.dismissed and installs nothing", async () => {
  const c = computer();
  c.privileged.answerWith(() => exited(126));
  expect((await setupRuntime(c.h)).status).toBe(202);
  expect(await finished(c.h)).toEqual({ phase: "failed", problem: { code: "setup.dismissed", data: {} } });
  expect(c.privileged.calls).toHaveLength(1);
  expect(c.operatorRunner.calls).toEqual([]);
  expect(c.podman.pulls).toEqual([]);
});

test("exit 127 is not authorised, which also covers a missing authentication agent", async () => {
  const c = computer();
  c.privileged.answerWith(() => exited(127));
  await setupRuntime(c.h);
  expect((await finished(c.h)).problem).toEqual({ code: "setup.not_authorised", data: {} });
});

test("another failure of the privileged step keeps its exit code in the message data", async () => {
  const c = computer();
  c.privileged.answerWith(() => exited(4));
  await setupRuntime(c.h);
  expect(await finished(c.h)).toEqual({ phase: "failed", problem: { code: "setup.failed", data: { code: 4 } } });
  expect(c.operatorRunner.calls).toEqual([]);
});

test("a package manager that fails in the real setup command ends as setup.failed with code 4", async () => {
  const c = computer();
  const failing = new RecordingRunner((argv) => (argv[1] === "install" ? exited(100) : exited(0)));
  c.privileged.answerWith(async (argv, say) => {
    const parsed = parseSetupCommand(argv);
    if (parsed === null || !parsed.ok) return exited(2);
    return exited(await runPodmanSetup({ user: parsed.user, files: c.rootFiles, runner: failing, print: say }));
  });
  await setupRuntime(c.h);
  expect((await finished(c.h)).problem).toEqual({ code: "setup.failed", data: { code: 4 } });
});

// Criterion: an unsupported distribution (recorded release file) skips the prompt and offers a remote engine.
test("an unsupported distribution skips the prompt and ends in setup.unsupported_distribution", async () => {
  const c = computer({ release: "gentoo" });
  const response = await setupRuntime(c.h);
  expect(response.status).toBe(202);
  const view = (await response.json()) as RuntimeSetupView;
  expect(view).toEqual({ phase: "failed", problem: { code: "setup.unsupported_distribution", data: { id: "gentoo" } } });
  expect(c.privileged.calls).toEqual([]);
  expect(c.rootRunner.calls).toEqual([]);
  // The server looked at the distribution itself, as the operator.
  expect(c.operatorFiles.reads).toEqual([OS_RELEASE_FILE]);
  // And it can be tried again later, because nothing is left running.
  expect((await setupRuntime(c.h)).status).toBe(202);
});

// Criterion: when a runtime already works, the setup step is not offered.
test("when a container tool already works the route refuses with setup.not_needed and nothing runs", async () => {
  const c = computer({ works: true });
  const response = await setupRuntime(c.h);
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toEqual({ code: "setup.not_needed", data: {} });
  expect(c.privileged.calls).toEqual([]);
  expect(c.h.runtimeSetup.view()).toBeNull();
});

test("a tool that works but cannot limit memory still counts as working", async () => {
  const machine = recordedMachine(linuxInputs({ rules: podmanRules("info-rootless-no-memory") }));
  const privileged = new FakePrivilegedRunner();
  const h = openHarness({ machine, setup: { privileged } });
  open.push(h);
  const response = await setupRuntime(h);
  expect(response.status).toBe(409);
  expect((await errorOf(response)).code).toBe("setup.not_needed");
  expect(privileged.calls).toEqual([]);
});

test("on a system that is not Linux the setup is not offered", async () => {
  const privileged = new FakePrivilegedRunner();
  const h = openHarness({
    localMachine: { platform: "darwin", arch: "arm64", totalMemory: 32 * 1024 ** 3, cpuCount: 8 },
    setup: { privileged },
  });
  open.push(h);
  const response = await setupRuntime(h);
  expect(response.status).toBe(409);
  expect((await errorOf(response)).code).toBe("setup.not_offered");
  expect(privileged.calls).toEqual([]);
});

// Criterion: after a successful setup, the machine check re-runs and the install step continues without a restart.
test("after the setup the migrate command runs as the operator, the machine check runs again, and the install goes on by itself", async () => {
  const c = computer();
  const before = (await (await fetch(`${c.h.base}/api/machine-check`)).json()) as MachineCheckView;
  expect(before.lines.find((line) => line.id === "runtime")?.message.code).toBe("machine.runtime_none");
  const gathersBefore = c.machine.calls.length;

  await setupRuntime(c.h);
  expect(await finished(c.h)).toEqual({ phase: "done", problem: null });

  expect(c.operatorRunner.calls).toEqual([["podman", "system", "migrate"]]);
  expect(c.machine.calls.length).toBeGreaterThan(gathersBefore);
  // The page's next read of the check sees the new state, not the answer from before the setup.
  const after = (await (await fetch(`${c.h.base}/api/machine-check`)).json()) as MachineCheckView;
  expect(after.lines.find((line) => line.id === "runtime")?.result).toBe("pass");

  await eventually(async () => {
    const view = (await (await fetch(`${c.h.base}/api/local-engine`)).json()) as LocalEngineView;
    return view.state === "ready";
  });
  expect(c.podman.pulls).toHaveLength(1);
  expect(c.podman.starts).toHaveLength(1);
});

test("the steps are announced in order: approval, installing, checking, done", async () => {
  const c = computer();
  const phases: SetupPhase[] = [];
  c.h.runtimeSetup.subscribe((view) => phases.push(view.phase));
  await setupRuntime(c.h);
  await finished(c.h);
  expect(phases).toEqual(["approval", "installing", "checking", "done"]);
});

test("a failed migrate does not stop the setup: the machine check decides", async () => {
  const c = computer();
  const h = openHarness({ machine: c.machine, runtimes: { podman: c.podman }, setup: {
    privileged: c.privileged,
    files: c.operatorFiles,
    runner: new ScriptedRunner([{ argv: ["podman", "system", "migrate"], result: exited(125) }]),
    operator: "alice",
  } });
  open.push(h);
  await setupRuntime(h);
  expect((await finished(h)).phase).toBe("done");
});

test("when the tool still does not work after the setup the message is setup.runtime_not_working and the install does not start", async () => {
  const c = computer();
  c.staysBroken();
  await setupRuntime(c.h);
  expect(await finished(c.h)).toEqual({ phase: "failed", problem: { code: "setup.runtime_not_working", data: {} } });
  expect(c.podman.pulls).toEqual([]);
});

test("a second click while the first is under way is refused", async () => {
  const c = computer();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.privileged.answerWith(async () => {
    await gate;
    return exited(126);
  });
  expect((await setupRuntime(c.h)).status).toBe(202);
  const second = await setupRuntime(c.h);
  expect(second.status).toBe(409);
  expect((await errorOf(second)).code).toBe("setup.already_running");
  release();
  await finished(c.h);
  expect(c.privileged.calls).toHaveLength(1);
});

// Criterion: the setup subcommand reads nothing from the operator's data folder while running as root.
test("the files read while running as the administrator are os-release, the two ID range files and the user list only", async () => {
  const c = computer();
  await setupRuntime(c.h);
  await finished(c.h);
  expect(new Set(c.rootFiles.reads)).toEqual(new Set([OS_RELEASE_FILE, SUBUID_FILE, SUBGID_FILE, PASSWD_FILE]));
  for (const path of c.rootFiles.reads) expect(path.startsWith(c.h.dataFolder)).toBe(false);
});

test("the setup follows the page over the live updates of the local engine", async () => {
  const c = computer();
  c.privileged.answerWith(() => exited(126));
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const response = await fetch(`${c.h.base}/api/local-engine/events`, { signal: abort.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const read = async (until: string) => {
    while (!text.includes(until)) {
      const chunk = await reader.read();
      if (chunk.done) return;
      text += decoder.decode(chunk.value);
    }
  };
  await read("event: local-engine");
  await setupRuntime(c.h);
  await read("setup.dismissed");
  expect(text).toContain("event: runtime-setup");
  expect(text).toContain('"phase":"failed"');
  abort.abort();
});

// The real privileged runner

test("the real privileged runner starts the running executable by its full path through pkexec", async () => {
  const runner = new ScriptedRunner([
    { argv: ["pkexec", "/opt/aidm/aidm-ui", "setup-podman", "--user", "alice"], result: exited(126) },
  ]);
  const result = await pkexecRunner("/opt/aidm/aidm-ui", runner).runAsRoot(["setup-podman", "--user", "alice"]);
  expect(result.exitCode).toBe(126);
  expect(runner.calls).toEqual([["pkexec", "/opt/aidm/aidm-ui", "setup-podman", "--user", "alice"]]);
});

test("the real privileged runner passes on the lines the program prints, not the ones pkexec complains with", async () => {
  const runner = new ScriptedRunner([
    {
      argv: ["pkexec", "/opt/aidm/aidm-ui", "x"],
      result: { exitCode: 0, stdout: "Installing Podman.\n", stderr: "a complaint\n" },
    },
  ]);
  const lines: string[] = [];
  await pkexecRunner("/opt/aidm/aidm-ui", runner).runAsRoot(["x"], (line) => lines.push(line));
  expect(lines).toEqual(["Installing Podman."]);
});

test("the real privileged runner needs a full path, so the prompt shows one", () => {
  expect(() => pkexecRunner("aidm-ui")).toThrow();
});

// One button: the install itself starts the setup where no container tool works.

const installEngine = (h: Harness) => post(h, "/api/local-engine/install");

test("with no container tool the install starts the setup and goes on to install the engine by itself", async () => {
  const c = computer();
  const response = await installEngine(c.h);
  expect(response.status).toBe(202);
  expect(c.privileged.calls).toEqual([["setup-podman", "--user", "alice"]]);
  expect(await finished(c.h)).toEqual({ phase: "done", problem: null });
  await eventually(async () => {
    const view = (await (await fetch(`${c.h.base}/api/local-engine`)).json()) as LocalEngineView;
    return view.state === "ready";
  });
  expect(c.privileged.calls).toHaveLength(1);
  expect(c.podman.pulls).toHaveLength(1);
  expect(c.podman.starts).toHaveLength(1);
});

test("a second click on the install while the setup is under way is refused with setup.already_running", async () => {
  const c = computer();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.privileged.answerWith(async () => {
    await gate;
    return exited(126);
  });
  expect((await installEngine(c.h)).status).toBe(202);
  const second = await installEngine(c.h);
  expect(second.status).toBe(409);
  expect(await errorOf(second)).toEqual({ code: "setup.already_running", data: {} });
  release();
  await finished(c.h);
  expect(c.privileged.calls).toHaveLength(1);
});

test("the install on an unsupported distribution answers at once and the view tells why, with no prompt", async () => {
  const c = computer({ release: "gentoo" });
  expect((await installEngine(c.h)).status).toBe(202);
  expect(c.h.runtimeSetup.view()).toEqual({
    phase: "failed",
    problem: { code: "setup.unsupported_distribution", data: { id: "gentoo" } },
  });
  expect(c.privileged.calls).toEqual([]);
});

test("the install is refused as before when the setup is not needed", async () => {
  // The check finds a working tool, but the runtime the engine would use is not there.
  const machine = recordedMachine(linuxInputs({ rules: podmanRules("info-rootless") }));
  const privileged = new FakePrivilegedRunner();
  const podman = new FakeRuntime({ detection: { available: false, version: null, problem: null } });
  const h = openHarness({ machine, runtimes: { podman }, setup: { privileged } });
  open.push(h);
  const response = await installEngine(h);
  expect(response.status).toBe(409);
  expect((await errorOf(response)).code).toBe("install.no_runtime");
  expect(privileged.calls).toEqual([]);
});

// A program that could not be started is not an answer of the desktop.

test("an approval program that is not there is setup.not_available, not a refusal", async () => {
  const c = computer();
  c.privileged.answerWith(() => ({ exitCode: 127, stdout: "", stderr: "", spawnFailure: "not_found" }));
  await setupRuntime(c.h);
  expect(await finished(c.h)).toEqual({ phase: "failed", problem: { code: "setup.not_available", data: {} } });
});

test("an approval program that cannot be run is setup.failed", async () => {
  const c = computer();
  c.privileged.answerWith(() => ({ exitCode: 126, stdout: "", stderr: "", spawnFailure: "cannot_run" }));
  await setupRuntime(c.h);
  const view = await finished(c.h);
  expect(view.problem?.code).toBe("setup.failed");
});

test("with the real runner a missing pkexec ends as setup.not_available and an exit code from pkexec as before", async () => {
  const missing = new ScriptedRunner([]);
  const c = computer();
  const h = openHarness({
    enginePollMs: 50,
    machine: c.machine,
    runtimes: { podman: c.podman },
    setup: { privileged: pkexecRunner("/opt/aidm/aidm-ui", missing), files: c.operatorFiles, runner: c.operatorRunner, operator: "alice" },
  });
  open.push(h);
  await setupRuntime(h);
  expect((await finished(h)).problem).toEqual({ code: "setup.not_available", data: {} });

  const dismissed = new ScriptedRunner([
    { argv: ["pkexec", "/opt/aidm/aidm-ui", "setup-podman", "--user", "alice"], result: exited(126) },
  ]);
  const h2 = openHarness({
    enginePollMs: 50,
    machine: c.machine,
    runtimes: { podman: c.podman },
    setup: { privileged: pkexecRunner("/opt/aidm/aidm-ui", dismissed), files: c.operatorFiles, runner: c.operatorRunner, operator: "alice" },
  });
  open.push(h2);
  await setupRuntime(h2);
  expect((await finished(h2)).problem).toEqual({ code: "setup.dismissed", data: {} });
});

// No time limit on a step that runs as the administrator.

test("the real privileged runner sets no time limit and no signal, because it cannot stop the program", async () => {
  let seen: CommandStreamOptions | undefined;
  const runner: CommandRunner = {
    run: async () => exited(0),
    stream: async (_argv, options) => {
      seen = options;
      return exited(0);
    },
  };
  await pkexecRunner("/opt/aidm/aidm-ui", runner).runAsRoot(["setup-podman", "--user", "alice"]);
  expect(seen).toBeDefined();
  expect(seen?.timeoutMs).toBeUndefined();
  expect(seen?.signal).toBeUndefined();
});

test("a step that is slow to end stays under way, and the view says so, until pkexec ends", async () => {
  const c = computer();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.privileged.answerWith(async (_argv, say) => {
    say("Installing Podman with apt.");
    await gate;
    return exited(126);
  });
  await setupRuntime(c.h);
  await eventually(async () => c.h.runtimeSetup.view()?.phase === "installing");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(c.h.runtimeSetup.view()?.phase).toBe("installing");
  release();
  await finished(c.h);
});

// What the privileged step printed goes to the log and nowhere else.

test("when the privileged step fails the last 20 lines it printed are in the server log and not in what the browser gets", async () => {
  const c = computer();
  c.privileged.answerWith((_argv, say) => {
    for (let n = 1; n <= 30; n++) say(`printed line ${n}`);
    return exited(4);
  });
  const response = await setupRuntime(c.h);
  const body = JSON.stringify(await response.json());
  await finished(c.h);
  const logged = c.h.logs.join("\n");
  expect(logged).toContain("printed line 30");
  expect(logged).toContain("printed line 11");
  expect(c.h.logs.some((line) => line.endsWith("printed line 10"))).toBe(false);
  expect(JSON.stringify(c.h.runtimeSetup.view())).not.toContain("printed line");
  expect(body).not.toContain("printed line");
});

test("the lines are also logged when Podman was installed but still does not work", async () => {
  const c = computer();
  c.staysBroken();
  c.privileged.answerWith((_argv, say) => {
    say("Podman is installed.");
    return exited(0);
  });
  await setupRuntime(c.h);
  await finished(c.h);
  expect(c.h.logs.some((line) => line.endsWith("Podman is installed."))).toBe(true);
});

// The distribution name reaches the browser, so it is cleaned.

test("a distribution ID is cut to 64 characters of letters, digits, dot, underscore and hyphen", async () => {
  const c = computer();
  c.operatorFiles.files[OS_RELEASE_FILE] = `ID="Odd id/with<b>markup & more${"x".repeat(100)}"\n`;
  await setupRuntime(c.h);
  const problem = c.h.runtimeSetup.view()?.problem;
  expect(problem?.code).toBe("setup.unsupported_distribution");
  const id = (problem?.data as { id: string }).id;
  expect(id).toMatch(/^[a-z0-9._-]{1,64}$/);
  expect(id.startsWith("odd_id_with_b_markup")).toBe(true);
  expect(id).toHaveLength(64);
});
