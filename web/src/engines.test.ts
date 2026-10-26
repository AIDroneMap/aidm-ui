import { expect, test } from "bun:test";
import { formatCount, formatMemory, parseEngineList } from "./engines.ts";

const good = {
  id: 1,
  kind: "remote",
  name: "Barn",
  address: "http://192.168.1.20:3000",
  enabled: true,
  state: "ready",
  supported: true,
  info: null,
  problem: null,
  warning: null,
};

test("a list of engines in an event is read", () => {
  expect(parseEngineList(JSON.stringify([good]))).toEqual([good as never]);
  expect(parseEngineList("[]")).toEqual([]);
});

test("anything that is not a list of engines is refused", () => {
  expect(parseEngineList("not json")).toBeNull();
  expect(parseEngineList("{}")).toBeNull();
  expect(parseEngineList(JSON.stringify([{ ...good, state: "sleeping" }]))).toBeNull();
  expect(parseEngineList(JSON.stringify([{ ...good, id: "1" }]))).toBeNull();
  expect(parseEngineList(JSON.stringify([good, 3]))).toBeNull();
});

test("memory is the engine's bytes in GiB with one decimal", () => {
  expect(formatMemory(64895025152)).toBe("60.4");
  expect(formatMemory(1073741824)).toBe("1.0");
});

test("counts use thousands separators", () => {
  expect(formatCount(1234)).toBe("1,234");
});
