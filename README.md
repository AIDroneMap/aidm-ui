# AIDM UI

**The open web interface for [AIDM](https://github.com/AIDroneMap/aidm), part of [AIDroneMap](https://github.com/AIDroneMap). Every machine, one command.**

AIDM UI lets a single operator create projects, bring in photos, review settings, run an engine, and view or download the results. It installs the engine on the operator's computer and can attach to a chosen task API endpoint.

> **Status: pre-alpha, not for use.** Projects, photo intake, reviewed settings, run history, downloads and offline viewers are implemented under specification #58. [Milestone 2](docs/milestones/0002-own-flight.md) records the completed checks and known limits. [Milestone 1](docs/milestones/0001-first-mac-run.md) records installation and the sample flow on Linux and Mac. Specifications are GitHub issues approved by a maintainer before development starts. The vocabulary is in [GLOSSARY.md](GLOSSARY.md) and decisions are in [docs/adr](docs/adr).

## What it does

- **Projects and photos.** Group photos into projects. Bring them in from the browser, from a folder on the same computer, or as a link the engine fetches itself. Before processing, see what the photos say about themselves: cameras, flights, photos without GPS, duplicates.
- **Presets and options.** Pick what you want out of a flight, from a quick map to a ground model, then change any option, each explained in plain words: what it does, when to change it, what it costs.
- **Runs.** Follow every run stage by stage, with its log. Cancel it, retry it, or run it again with other settings without sending the photos again.
- **Viewers.** Orthophotos and elevation models on a 2D map; the textured model in 3D. Point clouds in 3D come later.
- **Exports.** The whole results archive, or one output at a time: GeoTIFF, LAZ, OBJ, GLB, the report.
- **An engine on your own computer.** A first-run wizard checks the machine, installs the engine, and proves it with a sample job. No Docker, no terminal.
- **Local or cloud, per job.** Run small jobs on your own computer and send large ones to engines on your network or in the cloud, from the same interface.

What it will not do: user accounts, teams or billing. AIDM UI is for one operator. On a shared server, put it behind your own login and reverse proxy.

## Where it fits

| Part | Repository | Role |
| --- | --- | --- |
| Engine | [aidm](https://github.com/AIDroneMap/aidm) | Turns images into maps and models |
| Task API | [aidm-api](https://github.com/AIDroneMap/aidm-api) | Runs the engine and exposes it over HTTP |
| Web interface and local server | this repository | The operator's tool in the browser, and the engine manager that installs the engine on their computer |
| Desktop app | coming later | A desktop shell around the same server |

AIDM UI talks to every engine only through the task API, so it works the same with the engine on your computer, a server on your network, or a cloud endpoint.

## Technology

- A small server written in TypeScript on Bun, with SQLite, compiled into one executable per platform. It serves the interface, holds the engine manager, and makes every call to every engine.
- A single-page application built with TypeScript, React and Vite, compiled to static files and embedded in that executable, so there is nothing extra to install, and it works without an internet connection.
- MapLibre GL for the 2D map and three.js for the 3D model, both fed only from what the engine produced. The map has no basemap unless you configure one; no key, no token.
- The engine runs as a native package where one exists, and through a container runtime (Podman, Docker or Apple's container tool) until then. The wizard installs the runtime when the computer has none.

## Troubleshooting

### Logs for a bug report

AIDM UI writes a readable log of what it does to the terminal and to `logs/aidm-ui.log` in its data folder: each install step with its time and result, each command it runs (with tokens hidden), each download with every resume and its average speed, and each check that failed with what it expected and what it found. When the file reaches 5 MiB it becomes `aidm-ui.log.1`, and three older files are kept. The engine's own lines go to `logs/engine.log` next to it. The terminal and the file hold the same lines. An engine that stops answering gets three "Could not reach" lines, then one "Still unreachable" summary a minute until it answers again. If the file cannot be written, the terminal says so, and the file says how many lines it lacks once it can be written again.

The data folder is, unless `--data-dir` or the `AIDM_UI_DATA_DIR` environment variable names another:

| System | Data folder |
| --- | --- |
| macOS | `~/Library/Application Support/aidm-ui` |
| Linux | `~/.local/share/aidm-ui` (or `$XDG_DATA_HOME/aidm-ui`) |
| Windows | `%LOCALAPPDATA%\aidm-ui` |

Attach `logs/aidm-ui.log` (and `logs/engine.log` when the engine misbehaves) to a bug report. The log holds no engine token, but it holds the paths of your data folder, so look it over before you share it. For the complete output of every runtime command, start AIDM UI with `--record-runtime-commands`: that file is `diagnostics/runtime-commands.jsonl`.

At the end of every run, the log has one line that sums it up: its state, the engine's time, each stage's time, the warnings, the failed processes, and where the engine keeps the task's own log.

### On a Mac

AIDM UI runs the engine in Apple's container tool, which gives it a small network inside the Mac. When the engine runs but does not answer, the engines page says why. The causes found so far:

- **The Local Network permission.** macOS asks whether "container" may find devices on your local network, when the engine first starts. If the answer was no, turn it on in System Settings, Privacy & Security, Local Network: switch on "container". No restart is needed.
- **A VPN client that changes the route.** A VPN client that sends all traffic through an exit node can send the engine's traffic into its tunnel, or to your router, instead of to the engine. It may do it again each time it reconnects. Turn the exit node off while you use the engine on this Mac, or use an engine on another computer. Do not change the routes by hand: the client puts its own back at its next reconnect.

For a bug report from a Mac, send `logs/aidm-ui.log` and `logs/engine.log`, which hold every check and its result. With `--record-runtime-commands`, add `diagnostics/runtime-commands.jsonl`. Say which VPN setting was on, if any: whether all traffic went through an exit node, and whether the local network was allowed.

## Contributing

The project is pre-alpha. Development follows maintainer-approved specifications. Ideas and use cases help define what comes next. Open a discussion or an issue describing how you process drone data and what you need from the interface.

Read the [contributing guide](https://github.com/AIDroneMap/.github/blob/main/CONTRIBUTING.md) before opening a pull request. Every commit needs a DCO sign-off (`git commit -s`).

## Licence

AIDM UI is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its source code to the users of that service.

## Credits

AIDM UI is written from scratch for AIDroneMap. The engine it drives builds on [ODX](https://github.com/WebODM/ODX), [WebODM](https://github.com/WebODM) and [OpenDroneMap](https://github.com/OpenDroneMap). AIDroneMap is an independent project, not affiliated with or endorsed by WebODM or OpenDroneMap.

AIDroneMap is maintained by [Dimitri Albino](https://github.com/DimitriAlbino) and sponsored by [ITALDRONI](https://italdroni.it).
