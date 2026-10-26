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
One set of images captured together. Flights are detected from the images, never declared by the operator. Defined in a later specification.
_Avoid_: Mission, sortie, batch

**Run**:
One processing of a project's images on one engine, with its settings and its results.
_Avoid_: Job, task (except at the API boundary), processing

**Task**:
The task API's word for a run on one engine. Used only in code that talks to the API.
_Avoid_: Using "task" anywhere the operator can see it

**Sample dataset**:
The project's standard test dataset, pinned by commit and checksum, used for every test on real images.
_Avoid_: Demo data, example images

**Sample job**:
The run the wizard offers on the sample dataset, so a new installation proves itself end to end.
_Avoid_: Demo, tutorial run, test job
