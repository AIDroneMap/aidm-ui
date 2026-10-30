import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { LinkStore } from "./link-store.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db, migrations);
  const projectId = Number(db.query("INSERT INTO projects (name, created_at) VALUES ('Survey', '2024')").run().lastInsertRowid);
  return { db, projectId, store: new LinkStore(db) };
}

test("select stores only the original URL and associates runs with its revision", async () => {
  const { db, projectId, store } = setup();
  const methods: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    methods.push(request.method);
    return new Response(null, { headers: { "content-type": "application/zip", "content-length": "123" } });
  } });
  try {
    const url = `http://127.0.0.1:${server.port}/file?signature=a%2Fb+z`;
    expect(await store.select(projectId, url)).toEqual({ ok: true, size: 123 });
    expect(methods).toEqual(["HEAD"]);
    expect(store.get(projectId)).toBe(url);
    expect(store.has(projectId)).toBe(true);
    const revision = store.revision(projectId);
    const insert = db.query("INSERT INTO runs (project_id, options, state, created_at, updated_at) VALUES (?, '[]', 'completed', '2024', '2024')");
    const first = Number(insert.run(projectId).lastInsertRowid);
    const second = Number(insert.run(projectId).lastInsertRowid);
    store.recordRun(projectId, first);
    store.recordRun(projectId, second);
    expect(store.runIds(projectId)).toEqual([second, first]);
    store.clear(projectId);
    expect(store.revision(projectId)).toBe("");
    expect(store.runIds(projectId)).toEqual([]);
    expect(await store.select(projectId, url)).toEqual({ ok: true, size: 123 });
    expect(store.revision(projectId)).toBe(revision);
    expect(store.runIds(projectId)).toEqual([second, first]);
  } finally { server.stop(true); }
});

test("rejects invalid URLs without making a request", async () => {
  const { db, projectId } = setup();
  let calls = 0;
  const store = new LinkStore(db, (async () => { calls++; throw new Error(); }) as unknown as typeof fetch);
  for (const url of ["file:///tmp/a.zip", "http://user:pass@example.com/a.zip", "http://@example.com/a.zip", "http://example.com/a.zip#part", "http://example.com/a\n.zip", `http://example.com/${"a".repeat(8192)}`]) {
    expect(await store.select(projectId, url)).toEqual({ ok: false, code: "link.invalid_url" });
  }
  expect(calls).toBe(0);
});

test("checks response evidence and preserves the selected source on failure", async () => {
  const { projectId, store } = setup();
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/missing") return new Response(null, { status: 404 });
    if (path === "/html.zip") return new Response(null, { headers: { "content-type": "text/html", "content-length": "42" } });
    if (path === "/unknown") return new Response(null, { headers: { "content-type": "application/zip" } });
    if (path === "/huge") return new Response(null, { headers: { "content-type": "application/zip", "content-length": "9007199254740992" } });
    if (path === "/named") return new Response(null, { headers: { "content-disposition": 'attachment; filename="photos.ZIP"', "content-length": "42" } });
    return new Response(null, { headers: { "content-type": "application/octet-stream", "content-length": "42" } });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await store.select(projectId, `${base}/named`)).toEqual({ ok: true, size: 42 });
    for (const [path, code] of [["/missing", "link.unreachable"], ["/html.zip", "link.not_zip"], ["/unknown", "link.unknown_size"], ["/huge", "link.unknown_size"], ["/other", "link.not_zip"]] as const) {
      expect(await store.select(projectId, base + path)).toEqual({ ok: false, code });
    }
    expect(store.get(projectId)).toBe(`${base}/named`);
    expect(await store.select(projectId, `${base}/photos.zip`)).toEqual({ ok: true, size: 42 });
  } finally { server.stop(true); }
});

test("follows bounded HEAD redirects and rejects unsafe destinations", async () => {
  const { projectId, store } = setup();
  const methods: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    methods.push(request.method);
    const path = new URL(request.url).pathname;
    if (path === "/start") return new Response(null, { status: 302, headers: { location: "/photos.zip" } });
    if (path === "/loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
    if (path === "/unsafe") return new Response(null, { status: 302, headers: { location: "http://@example.com/file.zip" } });
    return new Response(null, { headers: { "content-type": "application/octet-stream", "content-length": "42" } });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await store.select(projectId, `${base}/start`)).toEqual({ ok: true, size: 42 });
    expect(store.get(projectId)).toBe(`${base}/start`);
    expect(await store.select(projectId, `${base}/loop`)).toEqual({ ok: false, code: "link.unreachable" });
    expect(await store.select(projectId, `${base}/unsafe`)).toEqual({ ok: false, code: "link.unreachable" });
    expect(methods).toEqual(Array(9).fill("HEAD"));
  } finally { server.stop(true); }
});
