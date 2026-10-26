import { expect, test } from "bun:test";
import { SESSION_COOKIE, Sessions } from "./sessions.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a session token is long, random and valid until cleared", () => {
  const sessions = new Sessions();
  const first = sessions.create();
  const second = sessions.create();
  expect(first).not.toBe(second);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sessions.isValid(first)).toBe(true);
  expect(sessions.isValid("made up")).toBe(false);
  expect(sessions.isValid(undefined)).toBe(false);
  sessions.clear();
  expect(sessions.isValid(first)).toBe(false);
});

test("a session lasts 30 days", () => {
  let now = 1_000_000;
  const sessions = new Sessions(() => now);
  const token = sessions.create();
  now += 29 * DAY;
  expect(sessions.isValid(token)).toBe(true);
  now += 2 * DAY;
  expect(sessions.isValid(token)).toBe(false);
});

test("the token is read from the cookie header among other cookies", () => {
  const sessions = new Sessions();
  const request = (cookie?: string) => new Request("http://x/", cookie ? { headers: { cookie } } : {});
  expect(sessions.fromRequest(request(`a=1; ${SESSION_COOKIE}=abc; b=2`))).toBe("abc");
  expect(sessions.fromRequest(request("a=1"))).toBeUndefined();
  expect(sessions.fromRequest(request())).toBeUndefined();
});

test("the cookie cannot be read by scripts or sent from another site", () => {
  expect(new Sessions().cookieFor("t")).toBe(
    `${SESSION_COOKIE}=t; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
});
