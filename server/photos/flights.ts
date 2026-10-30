import { createHash } from "node:crypto";

export interface FlightPhoto {
  sha256: string;
  captureTime: string | null;
  make: string | null;
  model: string | null;
  excluded: boolean;
}
export interface DetectedFlight {
  id: string;
  make: string | null;
  model: string | null;
  clock: "camera" | "offset";
  first: string;
  last: string;
  photoCount: number;
  excludedPhotoCount: number;
  checksums: string[];
}

export function captureMoment(captureTime: string | null): { time: number; clock: "camera" | "offset" } {
  const clock = captureTime !== null && /(?:Z|[+-]\d{2}:\d{2})$/.test(captureTime) ? "offset" : "camera";
  return { clock, time: captureTime === null ? NaN : Date.parse(captureTime + (clock === "camera" ? "Z" : "")) };
}

export function detectFlights(photos: FlightPhoto[]): { flights: DetectedFlight[]; unassignedCount: number } {
  const cameras = new Map<string, Array<FlightPhoto & { time: number; clock: "camera" | "offset" }>>();
  let unassignedCount = 0;
  for (const photo of photos) {
    const { clock, time } = captureMoment(photo.captureTime);
    if ((photo.make === null && photo.model === null) || !Number.isFinite(time)) { unassignedCount++; continue; }
    const key = JSON.stringify([photo.make, photo.model, clock]);
    const group = cameras.get(key) ?? [];
    group.push({ ...photo, time, clock });
    cameras.set(key, group);
  }
  const flights: DetectedFlight[] = [];
  for (const group of cameras.values()) {
    group.sort((a, b) => a.time - b.time || a.sha256.localeCompare(b.sha256));
    let flight: DetectedFlight | undefined;
    let previous = -Infinity;
    for (const photo of group) {
      if (flight === undefined || photo.time - previous > 30 * 60 * 1000) {
        flight = { id: "", make: photo.make, model: photo.model, clock: photo.clock, first: photo.captureTime!, last: photo.captureTime!, photoCount: 0, excludedPhotoCount: 0, checksums: [] };
        flights.push(flight);
      }
      flight.last = photo.captureTime!;
      flight.photoCount++;
      if (photo.excluded) flight.excludedPhotoCount++;
      flight.checksums.push(photo.sha256);
      previous = photo.time;
    }
  }
  for (const flight of flights) flight.id = createHash("sha256").update(JSON.stringify([flight.make, flight.model, flight.clock, flight.checksums])).digest("hex");
  flights.sort((a, b) => a.first.localeCompare(b.first) || a.id.localeCompare(b.id));
  return { flights, unassignedCount };
}
