# Install and test AIDM UI

A pilot's normal installation should be a download, an app to open, and the setup screens. Running a downloaded AIDM UI executable does not require Git, Bun, Node.js or a compiler.

**Current status: pre-alpha, not for use.**

## Get a release

Open the [releases page](https://github.com/AIDroneMap/aidm-ui/releases) and follow the install steps of the newest release.

| Computer | File | How to open it |
| --- | --- | --- |
| Apple silicon Mac | `aidm-ui-<version>-mac-apple-silicon.dmg` | Open the disk image, drag AIDM UI onto Applications, and open it from there |
| Linux x86-64 | `aidm-ui-<version>-linux-x64` | Allow the file to run as a program in the file manager, then run it |
| Linux arm64 | `aidm-ui-<version>-linux-arm64` | Allow the file to run as a program in the file manager, then run it |
| Windows x64 | `aidm-ui-<version>-windows-x64.exe` | Open it; use an engine on another computer |

The release notes say whether the Mac app is signed by its developer. When it is not, macOS refuses to open it the first time. Choose **Done**, then open System Settings, **Privacy & Security**, and choose **Open Anyway** next to the line about AIDM UI. macOS asks for this once.

Opening the Mac app starts AIDM UI in the background and opens its interface in the browser. Opening the app again while AIDM UI runs opens the interface again. AIDM UI keeps running until you log out or restart the Mac.

`SHA256SUMS` on the release page holds the checksum of every file.

## Get a test download between releases

1. Open [AIDM UI's CI runs on main](https://github.com/AIDroneMap/aidm-ui/actions/workflows/ci.yml?query=branch%3Amain) in your browser. Sign in to GitHub to download an artifact.
2. Choose a successful run on `main`. Confirm that **Build the four executables** passed, then scroll to **Artifacts**.
3. Download the artifact for your computer from the table below. These artifacts expire after seven days. An expired run is not an install source; choose a newer successful run.
4. Extract the downloaded ZIP into a folder you can keep. It contains the executable, including the interface. The engine is a separate download that the setup screens ask you to approve.

| Computer | Artifact | File inside | Current launch path |
| --- | --- | --- | --- |
| Linux x86-64 | `aidm-ui-linux-x64` | `aidm-ui-linux-x64` | Allow the file to run as a program in the file manager, then run it |
| Linux arm64 | `aidm-ui-linux-arm64` | `aidm-ui-linux-arm64` | Allow the file to run as a program in the file manager, then run it |
| Apple silicon Mac | `aidm-ui-macos-arm64` | `aidm-ui-macos-arm64` | A command-line test executable; the Mac app is on the releases page |
| Windows x64 | `aidm-ui-windows-x64` | `aidm-ui-windows-x64.exe` | Open the extracted executable; use an engine on another computer |

Linux file managers differ in how they launch executables. If yours cannot open this file, a desktop launcher is still missing for that setup. The Mac artifact is not a `.app` or `.dmg`, and the Windows artifact is not an installer. A pilot uses a release instead; these test downloads are for testers.

Every build accepts only the publisher's API release key. A build refuses to go ahead while a test key is accepted, unless it is a development build that is never published.

Once started, the executable opens the interface in your default browser. It listens on this computer by default. If the browser does not open, use the address shown by the executable. Keep the app running while using the interface.

## Choose and install an engine

The local engine needs Linux on x86-64-v3 or ARMv8.2-A, or a supported Apple silicon Mac. The setup screens check the computer and explain what is missing. Windows currently uses an engine on another computer. Building the UI for a platform does not establish that its local engine is supported.

### Use the released engine on this computer

The current built-in offer is the published API 2.7.0 package with engine 0.2.0 and manifest sequence 2007000. A new installation does not need a release-refresh workaround to get it. Earlier UI builds still offered 2.5.0, so use a build containing the [first-install correction](https://github.com/AIDroneMap/aidm-ui/issues/118).

1. Complete the setup wizard's computer check and choose **Install on this computer**.
2. Check the offered package version before approving its download. The offer must show 2.7.0 or a later released package for the in-place import test. Record what your installation actually offers; later releases can be newer.
3. Follow any container runtime setup prompts. The wizard supports Podman or Docker on Linux and Apple's container tool on a supported Mac. Approve only the installation you chose. Wait for the engine to become ready.
4. Open **Engines** and check the reported API and engine versions. They should match the package you selected.
5. If this is an existing test installation with an older engine, open **Engines** and use its **Update** action while it is idle. The corrected UI offers the built-in current package without a manual release check. Rebuilding the UI preserves existing data and does not silently interrupt work by replacing its installed engine. **Settings**, **Engine updates**, **Look for a newer engine now** remains available for later releases.

Signature, compatibility or installation errors are failures to investigate, not checks to bypass. The [milestone record](../milestones/0002-own-flight.md) names what has actually been exercised on each platform.

### Use an engine on another computer

Open **Engines**, choose **Add an engine**, and enter its name, task API address and token. Choose **Test connection**, then save it. Select that engine in each run's review. The AIDM UI server must be able to reach it. The browser does not connect directly to the engine, and the token stays on the server.

## First check: the sample job

1. Open **Sample job**. Check the dataset information, then select the ready engine.
2. Start the sample and approve the dataset download. Follow its reported state and log.
3. Wait for the run to finish **and for the result downloads to become available**. An engine finishing does not mean the server has finished saving its archive.
4. Download the archive and an individual output. Check that the ZIP opens and its files are present. Open the orthophoto in a program that reads GeoTIFF, if available.
5. Open the map if the run produced tiles. Pan and zoom, and try the available layers. A run without tiles correctly has no map.
6. Open the 3D model if a GLB was produced. Orbit and zoom, close it and reopen it. Leave the basemap off to check that the viewers need no external tile service.

Do not expect every preset to produce every output. The interface should show the files the engine actually made, or explain that a viewer is unavailable.

## Test your project through each way in

Start with the [public vineyard dataset](https://huggingface.co/datasets/AIDroneMap/aidm-vineyard-small). Keep an extracted copy outside the UI's data folder. Make a new project for each way in; the sample project cannot take other photos.

### Browser upload

Create a project, give it a name and notes, and select or drop the photos in its upload area. Wait for preparation to finish. Check the photo count, camera and GPS facts, and any exclusions. Choose **Quick map**, check the selected engine and review, then start the run. Reload while uploading to check that already received chunks resume instead of starting over. After completion, repeat the archive and available-viewer checks above.

### Import a folder

On the computer running the UI server, create an empty project and choose **Import a folder**. Enter the full path to the folder holding the photos, not the UI's data folder. Check the included files and photo facts.

With a capable same-machine API, review offers **Let the engine read the photos where they are**. If sharing a new folder requires restarting the local engine, the review says so. Start only while that engine is idle. The imported folder is mounted read-only for a container engine. An engine elsewhere uses a copy instead.

Complete a Quick map run. Repeat with **Copy the photos to the engine** if you want to check both choices. Exclusions, nested photos or duplicate aliases that the API cannot represent also require copy mode. Check that the review preserves the exact selected photos. Do not edit or move originals while a run depends on them.

### Link a ZIP

Create another project, choose **Link a ZIP archive**, and enter a public ZIP URL that the engine can reach. Use **Check and save link** before starting. The pinned sample archive used by this version is:

```text
https://huggingface.co/datasets/AIDroneMap/aidm-vineyard-small/resolve/6af198c9a327e187e088ede6d7c632eb77b50eaa/aidm-vineyard-small-v1.zip
```

Choose Quick map and review the run. Photo facts can be unknown before the engine downloads the ZIP; this is expected. After completion, check the saved photo facts and results. This route asks the chosen engine to fetch the archive, rather than uploading its photos through the browser.

## Check retained runs and settings

1. Open a completed project run and choose **Run again with other settings**. Change an available option, check its explanation and validation, and review the new settings before starting.
2. When the new run's downloads are ready, confirm that the earlier run's settings, log and archive remain available.
3. Save a named preset, export its settings, and import that file again. Review any settings the selected engine cannot use instead of assuming they were applied.
4. Close and reopen the app. Check that project names, notes, settings and completed archives remain.
5. Delete only the test rerun and confirm the earlier run remains. Delete the imported test project and confirm the original folder and its files still exist and their contents have not changed. Uploaded copies and saved results are removed according to the confirmation dialog.

For a stronger preservation check, record the originals' checksums before processing and compare them after deletion. Do not require identical creation-change times: creating hard links can change ctime without changing photo contents.

To test an engine on another physical computer, repeat a project run with that engine selected and record both computers. A second engine instance on one computer does not establish that result.

## Record a pass or a failure

Keep the UI commit or CI run, OS and processor, API and engine versions, manifest sequence for a managed install, the input dataset and each step's outcome. Record any missing viewer output separately from a viewer failing to open an output that exists. Link the actual result and describe anything skipped. Do not infer speed, memory use or a queue position from the test.

For a failure, keep the visible error and review the logs described in the [README](../../README.md#logs-for-a-bug-report). Inspect logs for local paths before sharing them. Do not post tokens, photos or result archives in a public issue. Turn off the local engine from **Engines** when the test is finished.

## For contributors only

These commands are for building and checking the source. They are not a pilot's installation steps.

Install the Bun version pinned in `scripts/ci/install-bun.sh`, currently 1.4.4, and Chrome or Chromium for the browser tests. Then:

```sh
git clone https://github.com/AIDroneMap/aidm-ui.git
cd aidm-ui
bun install --frozen-lockfile
bun run typecheck
bun test
```

If the browser is not discovered automatically, set `CHROME_BIN` or `CHROMIUM_BIN` to its executable. The source suite does not run the real runtime or native API checks unless their environment flags are enabled. CI runs those separately; see [the workflow](../../.github/workflows/ci.yml). They do not replace the real processing checks above.

A private development executable for Linux x64 can be built with:

```sh
bun scripts/build.ts --development linux-x64
```

The output is `dist/aidm-ui-linux-x64`. Other target names are `linux-arm64`, `macos-arm64` and `windows-x64`; the Windows file has an `.exe` suffix. The development flag skips the check that refuses a test key, and must not be used to publish a release. No key, signing rule or release setting needs to change to follow this guide.

For frontend development, `bun run dev` builds the interface and starts the source server. For real processing acceptance, use a machine with the engine runtime and follow the repository's testing rules.
