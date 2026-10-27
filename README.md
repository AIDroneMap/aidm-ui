# AIDM UI

**The open web interface for [AIDM](https://github.com/AIDroneMap/aidm), part of [AIDroneMap](https://github.com/AIDroneMap). Every machine, one command.**

AIDM UI will give a single operator a complete drone mapping tool in the browser: create a project, upload images, check them, start processing, follow progress, and view and export the results. It installs the AIDM engine on the operator's own computer without Docker or a terminal, and works with any AIDM task API on the network or in the cloud.

> **Status: pre-alpha, not for use.** The first specification ([#2](https://github.com/AIDroneMap/aidm-ui/issues/2), local server and engine manager) is built: the executable, the wizard that checks the machine and installs the engine, the sample job, and remote engines. Projects, uploads, the viewers and exports are not written yet. Specifications are published as GitHub issues and approved by a maintainer before development starts. The vocabulary is in [GLOSSARY.md](GLOSSARY.md) and the decisions so far are in [docs/adr](docs/adr).

## What it will do

- **Projects and uploads.** Group images into projects and upload them, with a dataset pre-flight report that flags blurry images, missing GPS data and poor overlap before you spend time processing.
- **Task setup.** Choose processing options through presets, with full control when you need it.
- **Job queue.** Follow every job stage by stage, with logs.
- **Viewers.** Orthophotos and elevation models in a 2D map view; point clouds and textured models in a 3D view.
- **Exports.** GeoTIFF, LAZ, OBJ and 3D Tiles.
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
- Planned: MapLibre GL for the 2D map, and a three.js viewer that streams point clouds for 3D.
- The engine runs as a native package where one exists, and through a container runtime (Podman, Docker or Apple's container tool) until then. The wizard installs the runtime when the computer has none.

## Logs for a bug report

AIDM UI writes a readable log of what it does to the terminal and to `logs/aidm-ui.log` in its data folder: each install step with its time and result, each command it runs (with tokens hidden), each download with every resume and its average speed, and each check that failed with what it expected and what it found. When the file reaches 5 MiB it becomes `aidm-ui.log.1`, and three older files are kept. The engine's own lines go to `logs/engine.log` next to it.

The data folder is, unless `--data-dir` or the `AIDM_UI_DATA_DIR` environment variable names another:

| System | Data folder |
| --- | --- |
| macOS | `~/Library/Application Support/aidm-ui` |
| Linux | `~/.local/share/aidm-ui` (or `$XDG_DATA_HOME/aidm-ui`) |
| Windows | `%LOCALAPPDATA%\aidm-ui` |

Attach `logs/aidm-ui.log` (and `logs/engine.log` when the engine misbehaves) to a bug report. The log holds no engine token, but it holds the paths of your data folder, so look it over before you share it. For the complete output of every runtime command, start AIDM UI with `--record-runtime-commands`: that file is `diagnostics/runtime-commands.jsonl`.

## Contributing

The project is pre-alpha and most of the interface has no specification yet, so the most useful contributions right now are ideas and use cases. Open a discussion or an issue describing how you process drone data and what you need from the interface.

Read the [contributing guide](https://github.com/AIDroneMap/.github/blob/main/CONTRIBUTING.md) before opening a pull request. Every commit needs a DCO sign-off (`git commit -s`).

## Licence

AIDM UI is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its source code to the users of that service.

## Credits

AIDM UI is written from scratch for AIDroneMap. The engine it drives builds on [ODX](https://github.com/WebODM/ODX), [WebODM](https://github.com/WebODM) and [OpenDroneMap](https://github.com/OpenDroneMap). AIDroneMap is an independent project, not affiliated with or endorsed by WebODM or OpenDroneMap.

AIDroneMap is maintained by [Dimitri Albino](https://github.com/DimitriAlbino) and sponsored by [ITALDRONI](https://italdroni.it).
