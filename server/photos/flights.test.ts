import { expect, test } from "bun:test";
import { detectFlights, type FlightPhoto } from "./flights.ts";

function photo(sha256: string, captureTime: string | null, model: string | null = "Survey camera", excluded = false): FlightPhoto {
  return { sha256, captureTime, make: model === null ? null : "Camera maker", model, excluded };
}

test("a gap of exactly thirty minutes stays in a flight, and a longer gap starts another", () => {
  const result = detectFlights([
    photo("c", "2026-10-29T10:00:01"),
    photo("b", "2026-10-29T09:30:00"),
    photo("a", "2026-10-29T09:00:00"),
    photo("d", "2026-10-29T09:15:00", "Other camera"),
  ]);
  expect(result.flights.map(flight => ({ count: flight.photoCount, first: flight.first, last: flight.last, model: flight.model }))).toEqual([
    { count: 2, first: "2026-10-29T09:00:00", last: "2026-10-29T09:30:00", model: "Survey camera" },
    { count: 1, first: "2026-10-29T09:15:00", last: "2026-10-29T09:15:00", model: "Other camera" },
    { count: 1, first: "2026-10-29T10:00:01", last: "2026-10-29T10:00:01", model: "Survey camera" },
  ]);
  expect(result.unassignedCount).toBe(0);
});

test("recorded offsets compare instants and remain separate from camera time", () => {
  const result = detectFlights([
    photo("a", "2026-10-29T09:00:00+02:00"),
    photo("b", "2026-10-29T07:30:00Z"),
    photo("c", "2026-10-29T08:00:01Z"),
    photo("d", "2026-10-29T07:15:00"),
    photo("e", null),
    photo("f", "2026-10-29T09:00:00", null),
  ]);
  expect(result.unassignedCount).toBe(2);
  expect(result.flights.find(flight => flight.photoCount === 2)).toMatchObject({ first: "2026-10-29T09:00:00+02:00", last: "2026-10-29T07:30:00Z", clock: "offset" });
  expect(result.flights.filter(flight => flight.clock === "offset")).toHaveLength(2);
  expect(result.flights.find(flight => flight.clock === "camera")).toMatchObject({ first: "2026-10-29T07:15:00", photoCount: 1 });
});

test("flight identity ignores arrival order and selections remain per photo", () => {
  const first = photo("a", "2026-10-29T09:00:00");
  const second = photo("b", "2026-10-29T09:15:00", "Survey camera", true);
  const initial = detectFlights([first, second]).flights[0]!;
  const reordered = detectFlights([second, first]).flights[0]!;
  expect(reordered.id).toBe(initial.id);
  expect(reordered.excludedPhotoCount).toBe(1);
  expect(reordered.checksums).toEqual(["a", "b"]);
  expect(detectFlights([{ ...first, excluded: true }, second]).flights[0]!.id).toBe(initial.id);
});
