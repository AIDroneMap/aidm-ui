# AIDM UI

The web interface and local server of AIDroneMap. One operator uses it to install an engine on their own computer, attach engines elsewhere, and run photogrammetry jobs on them.

## Language

### People and places

**Operator**:
The one person using an aidm-ui installation. There are no accounts, so "operator" is the only user.
_Avoid_: User, account, member

**Engine**:
An AIDM processing service reached through the task API, identified by an address and a token.
_Avoid_: Node, processing node, worker, server

**Local engine**:
An engine the engine manager installed and runs on the operator's computer.
_Avoid_: Built-in engine, embedded engine

**Remote engine**:
An engine on another machine, added by the operator with its address and token.
_Avoid_: Cloud engine, external node

### Installing and running engines

**Engine package**:
A release of the engine together with its task API, in one of two kinds. A native package is a folder the engine manager unpacks and runs as a process. A container package is an image it runs through a container runtime.
_Avoid_: Image (when the kind does not matter), bundle, distribution

**Engine manager**:
The part of the aidm-ui server that installs, starts, watches, updates and removes the local engine.
_Avoid_: Installer, supervisor, orchestrator

**Container runtime**:
The tool a container package runs through: Podman, Docker, or Apple's `container`.
_Avoid_: Docker (as a generic word), virtualiser

**Manifest**:
The signed file an engine release publishes to say which packages exist, how big they are, and how to verify them.
_Avoid_: Release index, catalogue, feed

**Wizard**:
The first-run flow that checks the machine, installs an engine or attaches one, and offers the sample job.
_Avoid_: Onboarding, setup assistant

### Work

**Project**:
A named collection of flights and runs.
_Avoid_: Job, survey, site

**Flight**:
One set of photos captured together: the photos of one camera whose capture times run on with no gap longer than thirty minutes. Flights are detected from the photos, never declared by the operator. A run may leave a flight out.
_Avoid_: Mission, sortie, batch

**Run**:
One processing of a project's photos on one engine, with its run settings, its log and its archive.
_Avoid_: Job, task (except at the API boundary), processing

**Stage**:
One step of the engine's pipeline, named on the run page in the operator's words.
_Avoid_: Phase; step (reserved for what the interface does around a run, such as uploading or fetching results)

**Task**:
The task API's word for a run on one engine. Used only in code that talks to the API.
_Avoid_: Using "task" anywhere the operator can see it

**Sample dataset**:
The project's standard test dataset, pinned by commit and checksum, used for every test on real images.
_Avoid_: Demo data, example images

**Sample job**:
The run the wizard offers on the sample dataset, so a new installation proves itself end to end.
_Avoid_: Demo, tutorial run, test job

### Bringing photos in

**Way in**:
How a project's photos reach the engine. There are three: upload, import and link.
_Avoid_: Source (for all three together), ingest

**Upload**:
Photos sent from the browser to the aidm-ui server, which keeps the only copy.
_Avoid_: Transfer, push

**Import**:
Photos read from a folder on the server's machine, in place. The folder is never changed.
_Avoid_: Sync, attach

**Link**:
The address of one zip file of photos that the engine fetches itself. The photos never pass through the operator's machine.
_Avoid_: Remote dataset, URL import

### Choosing what to produce

**Preset**:
A named set of option values chosen by what the operator wants out, such as a quick map or a ground model.
_Avoid_: Profile, template, mode

**Option**:
One setting of the engine as the catalogue describes it, with a plain name and the engine's own name.
_Avoid_: Flag, parameter, argument (except in code)

**Catalogue**:
The described set of options: for each one its facts and its explanation in the operator's words.
_Avoid_: Schema, dictionary, option list

**Run settings**:
The option values of one run, as sent to the engine. They can be saved as a file and loaded again.
_Avoid_: Configuration, config

**Review**:
The screen between the run settings and the start of a run, which shows what will be processed, where, and what will come out.
_Avoid_: Summary, confirmation

### Results

**Archive**:
The results file of one run, as the engine made it.
_Avoid_: Results zip, bundle

**Output**:
One named file inside an archive: the orthophoto, the surface model, the ground model, the point cloud, the 3D model or the report.
_Avoid_: Asset, artefact, deliverable

**Basemap**:
The tile source an operator may configure under the map. There is none unless the operator adds one.
_Avoid_: Background layer; tiles (which are the engine's output)
