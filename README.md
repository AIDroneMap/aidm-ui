# AIDM UI

**The open web interface for [AIDM](https://github.com/AIDroneMap/aidm), part of [AIDroneMap](https://github.com/AIDroneMap). Every machine, one command.**

AIDM UI will give a single operator a complete drone mapping tool in the browser: create a project, upload images, check them, start processing, follow progress, and view and export the results. It works with any AIDM task API, on the same computer or in the cloud.

> **Status: planning.** There is no code yet. The first step is a written specification, which will be published in `docs/specs/` before development starts.

## What it will do

- **Projects and uploads.** Group images into projects and upload them, with a dataset pre-flight report that flags blurry images, missing GPS data and poor overlap before you spend time processing.
- **Task setup.** Choose processing options through presets, with full control when you need it.
- **Job queue.** Follow every job stage by stage, with logs.
- **Viewers.** Orthophotos and elevation models in a 2D map view; point clouds and textured models in a 3D view.
- **Exports.** GeoTIFF, LAZ, OBJ and 3D Tiles.
- **Local or cloud, per job.** Run small jobs on your own computer and send large ones to cloud GPUs, from the same interface.

What it will not do: user accounts, teams or billing. AIDM UI is for one operator. On a shared server, put it behind your own login and reverse proxy.

## Where it fits

| Part | Repository | Role |
| --- | --- | --- |
| Engine | [aidm](https://github.com/AIDroneMap/aidm) | Turns images into maps and models |
| Task API | [aidm-api](https://github.com/AIDroneMap/aidm-api) | Runs the engine and exposes it over HTTP |
| Web interface | this repository | The operator's tool in the browser |
| Desktop app | coming later | Installs everything on Windows, macOS or Linux in one step |

AIDM UI talks to the engine only through the task API, so it works the same with a local engine, a server on your network, or a cloud endpoint.

## Planned technology

Subject to the specification:

- A single-page application built with TypeScript, React and Vite, compiled to static files.
- Served by the task API container, so there is nothing extra to install, and usable without an internet connection.
- MapLibre GL for the 2D map, and a three.js viewer that streams point clouds for 3D.

## Contributing

The project is at the specification stage, so the most useful contributions right now are ideas and use cases. Open a discussion or an issue describing how you process drone data and what you need from the interface.

Read the [contributing guide](https://github.com/AIDroneMap/.github/blob/main/CONTRIBUTING.md) before opening a pull request. Every commit needs a DCO sign-off (`git commit -s`).

## Licence

AIDM UI is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its source code to the users of that service.

## Credits

AIDM UI is written from scratch for AIDroneMap. The engine it drives builds on [ODX](https://github.com/WebODM/ODX), [WebODM](https://github.com/WebODM) and [OpenDroneMap](https://github.com/OpenDroneMap). AIDroneMap is an independent project, not affiliated with or endorsed by WebODM or OpenDroneMap.

AIDroneMap is maintained by [Dimitri Albino](https://github.com/DimitriAlbino) and sponsored by [ITALDRONI](https://italdroni.it).
