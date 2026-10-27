import { expect, test } from "bun:test";
import { engineInstall } from "../../web/src/localEngine.fixtures.ts";
import { StepLog } from "./step-log.ts";

test("each install step is logged when it starts and when it ends, with how long it took and how it ended", () => {
  const lines: string[] = [];
  let at = 0;
  const steps = new StepLog("Install", (line) => lines.push(line), () => at);
  steps.observe(engineInstall({ phase: "preparing", step: "init" }), null);
  at = 2500;
  steps.observe(engineInstall({ phase: "pulling", stepReceived: 10 }), null);
  steps.observe(engineInstall({ phase: "pulling", stepReceived: 20 }), null);
  at = 64_000;
  steps.observe(engineInstall({ phase: "loading" }), null);
  at = 70_000;
  steps.observe(engineInstall({ phase: "failed" }), { code: "install.load_failed", data: { exitCode: 1 } });
  expect(lines).toEqual([
    "Install step startup files of Apple's tool: started",
    "Install step startup files of Apple's tool: done, after 2.5 s",
    "Install step download of the engine linux-amd64-cpu: started",
    "Install step download of the engine linux-amd64-cpu: done, after 61.5 s",
    "Install step load of the engine into the runtime: started",
    'Install step load of the engine into the runtime: failed: install.load_failed {"exitCode":1}, after 6.0 s',
  ]);
});
