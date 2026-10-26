import { expect, test } from "bun:test";
import type { EngineView } from "../../shared/api-types.ts";
import { formatCount, formatMemory, parseEngineList, sameAddress, stateChanges } from "./engines.ts";

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

const barn = good as EngineView;

test("a change of state is named, and a new or removed engine is not a change", () => {
  const busy = { ...barn, state: "busy" } as EngineView;
  const other = { ...barn, id: 2 } as EngineView;
  expect(stateChanges([barn], [busy])).toEqual([busy]);
  expect(stateChanges([barn], [barn])).toEqual([]);
  expect(stateChanges([barn], [barn, other])).toEqual([]);
  expect(stateChanges([barn, other], [barn])).toEqual([]);
  expect(stateChanges([], [barn])).toEqual([]);
});

test("a trailing slash or a space does not make an address different", () => {
  expect(sameAddress("http://192.168.1.20:3000/", " http://192.168.1.20:3000")).toBe(true);
  expect(sameAddress("http://192.168.1.20:3000", "http://192.168.1.21:3000")).toBe(false);
});
