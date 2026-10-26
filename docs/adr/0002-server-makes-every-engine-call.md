---
status: accepted
date: 2026-10-26
---

# The aidm-ui server makes every engine call; the browser never holds an engine token

The task API accepts its token only as a query parameter on every request, and answers a wrong token with HTTP 200 and an error body. A browser calling engines directly would put tokens in its history, in proxy logs and in any screenshot of the address bar. We decided that the frontend talks only to the aidm-ui server, and the server makes every call to every engine, local or remote. Engine tokens live in the server's database and never reach the browser. This also gives one place to normalise engine statuses, check error bodies and apply the plain-HTTP rule for remote addresses.

## Consequences

- Large uploads and downloads pass through the server. They must stream, never buffer whole files.
- The server is the only client of the task API, so the task-client code has one caller and one set of contract tests.
- The server's own listener is loopback-only by default, and opening it to the local network requires a passphrase, because the server holds every token.
