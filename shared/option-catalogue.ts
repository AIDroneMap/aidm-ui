// Source: https://github.com/AIDroneMap/aidm/blob/68c643965349e7e0bb5e2a0595bcbeca645c70fe/modules/config.py
// The facts of the 17 entries ADR 0012 shows come from the recorded 2.7.0 list in test-support/fixtures/task-api-2.7.0-options.json.
// How the affects tags are chosen: docs/notes/0138-affects-tags.md.
export const PRESET_IDS = ["quick-map", "map-with-heights", "3d-model", "ground-model", "multispectral-map", "custom"] as const;

/** The groups of the settings editor, in the order a run proceeds. */
export const OPTION_GROUPS = ["photos-and-cameras", "matching-and-reconstruction", "point-cloud", "mesh-and-texture", "elevation-models", "orthophoto", "outputs-and-formats", "performance-and-limits", "expert"] as const;

/** What an option can change: a cost of the run, or one of its outputs. */
export const AFFECTS = ["quality", "time", "memory", "disk", "orthophoto", "surface-model", "ground-model", "point-cloud", "3d-model", "report"] as const;

/** Why an option cannot be edited. "always-on": the task API turns it on for every task, whatever the client sends. */
export const LOCK_REASONS = ["always-on"] as const;

export type PresetId = (typeof PRESET_IDS)[number];
export type OptionGroup = (typeof OPTION_GROUPS)[number];
export type Affect = (typeof AFFECTS)[number];
export type LockReason = (typeof LOCK_REASONS)[number];
export type OptionValue = string | number | boolean;
export type OptionDependency =
  | { kind: "option"; name: string; value: OptionValue }
  | { kind: "any"; alternatives: readonly OptionDependency[] }
  | { kind: "dataset"; fact: "bands" | "videos" };
export type ShownOption = {
  name: string; bin: "shown"; group: OptionGroup; type: "int" | "float" | "string" | "bool" | "enum";
  domain: string | readonly string[]; defaultValue: OptionValue;
  presets: Partial<Record<PresetId, OptionValue>>; dependencies: readonly OptionDependency[];
  costTag: "processing-time" | "processing-time-and-memory" | "disk-space" | null;
  affects: readonly Affect[]; locked: LockReason | null;
  /** The engine computes this default from the machine it runs on, so a different default is no change. */
  machineDefault?: true;
};
/** An engine argument the task API does not offer: no value sent for it reaches the engine. */
export type UnreachableOption = { name: string; bin: "not-offered"; group?: never };
export type CatalogueOption = ShownOption | UnreachableOption;

export const OPTION_CATALOGUE: readonly CatalogueOption[] = [
  { name: "camera-lens", bin: "shown", group: "photos-and-cameras", type: "enum", domain: ["auto","perspective","brown","fisheye","fisheye_opencv","spherical","equirectangular","dual"], defaultValue: "auto", presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "rolling-shutter", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "rolling-shutter-readout", bin: "shown", group: "photos-and-cameras", type: "float", domain: "positive integer", defaultValue: 0, presets: {}, dependencies: [{"kind":"option","name":"rolling-shutter","value":true}], costTag: null, affects: ["quality"], locked: null },
  { name: "use-fixed-camera-params", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "cameras", bin: "shown", group: "photos-and-cameras", type: "string", domain: "json", defaultValue: "", presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "gps-accuracy", bin: "shown", group: "photos-and-cameras", type: "float", domain: "positive float", defaultValue: 3, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "gps-z-offset", bin: "shown", group: "photos-and-cameras", type: "float", domain: "float", defaultValue: 0, presets: {}, dependencies: [], costTag: null, affects: ["surface-model","ground-model","point-cloud","3d-model"], locked: null },
  { name: "force-gps", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "use-exif", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "radiometric-calibration", bin: "shown", group: "photos-and-cameras", type: "enum", domain: ["none","camera","camera+sun"], defaultValue: "none", presets: {"multispectral-map":"camera"}, dependencies: [{"kind":"dataset","fact":"bands"}], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "primary-band", bin: "shown", group: "photos-and-cameras", type: "string", domain: "string", defaultValue: "auto", presets: {}, dependencies: [{"kind":"dataset","fact":"bands"}], costTag: null, affects: ["quality"], locked: null },
  { name: "skip-band-alignment", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [{"kind":"dataset","fact":"bands"}], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "video-limit", bin: "shown", group: "photos-and-cameras", type: "int", domain: "positive integer", defaultValue: 500, presets: {}, dependencies: [{"kind":"dataset","fact":"videos"}], costTag: null, affects: ["quality"], locked: null },
  { name: "video-resolution", bin: "shown", group: "photos-and-cameras", type: "int", domain: "positive integer", defaultValue: 4000, presets: {}, dependencies: [{"kind":"dataset","fact":"videos"}], costTag: null, affects: ["quality"], locked: null },
  { name: "sky-removal", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "bg-removal", bin: "shown", group: "photos-and-cameras", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "min-num-features", bin: "shown", group: "matching-and-reconstruction", type: "int", domain: "integer", defaultValue: 10000, presets: {}, dependencies: [], costTag: "processing-time", affects: ["quality","time"], locked: null },
  { name: "feature-type", bin: "shown", group: "matching-and-reconstruction", type: "enum", domain: ["akaze","dspsift","hahog","orb","sift"], defaultValue: "dspsift", presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "feature-quality", bin: "shown", group: "matching-and-reconstruction", type: "enum", domain: ["ultra","high","medium","low","lowest"], defaultValue: "high", presets: {}, dependencies: [], costTag: "processing-time-and-memory", affects: ["quality","time","memory"], locked: null },
  { name: "matcher-type", bin: "shown", group: "matching-and-reconstruction", type: "enum", domain: ["auto","bow","bruteforce","flann","hamming"], defaultValue: "auto", presets: {}, dependencies: [], costTag: "processing-time", affects: ["quality","time"], locked: null },
  { name: "matcher-neighbors", bin: "shown", group: "matching-and-reconstruction", type: "int", domain: "positive integer", defaultValue: 0, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "matcher-order", bin: "shown", group: "matching-and-reconstruction", type: "int", domain: "positive integer", defaultValue: 0, presets: {}, dependencies: [], costTag: "processing-time", affects: ["time"], locked: null },
  { name: "sfm-algorithm", bin: "shown", group: "matching-and-reconstruction", type: "enum", domain: ["incremental","triangulation","planar"], defaultValue: "incremental", presets: {}, dependencies: [], costTag: "processing-time", affects: ["quality","time"], locked: null },
  { name: "use-hybrid-bundle-adjustment", bin: "shown", group: "matching-and-reconstruction", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "processing-time", affects: ["time"], locked: null },
  { name: "sfm-no-partial", bin: "shown", group: "matching-and-reconstruction", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "pc-quality", bin: "shown", group: "point-cloud", type: "enum", domain: ["ultra","high","medium","low","lowest"], defaultValue: "medium", presets: {}, dependencies: [], costTag: "processing-time-and-memory", affects: ["quality","time","memory","point-cloud"], locked: null },
  { name: "pc-filter", bin: "shown", group: "point-cloud", type: "float", domain: "positive float", defaultValue: 5, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: null },
  { name: "pc-sample", bin: "shown", group: "point-cloud", type: "float", domain: "positive float", defaultValue: 0, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: null },
  { name: "pc-skip-geometric", bin: "shown", group: "point-cloud", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality","point-cloud"], locked: null },
  { name: "pc-classify", bin: "shown", group: "point-cloud", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: null },
  { name: "smrf-scalar", bin: "shown", group: "point-cloud", type: "float", domain: "positive float", defaultValue: 1.25, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dtm","value":true},{"kind":"option","name":"pc-classify","value":true}]}], costTag: null, affects: ["ground-model","point-cloud"], locked: null },
  { name: "smrf-slope", bin: "shown", group: "point-cloud", type: "float", domain: "positive float", defaultValue: 0.15, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dtm","value":true},{"kind":"option","name":"pc-classify","value":true}]}], costTag: null, affects: ["ground-model","point-cloud"], locked: null },
  { name: "smrf-threshold", bin: "shown", group: "point-cloud", type: "float", domain: "positive float", defaultValue: 0.5, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dtm","value":true},{"kind":"option","name":"pc-classify","value":true}]}], costTag: null, affects: ["ground-model","point-cloud"], locked: null },
  { name: "smrf-window", bin: "shown", group: "point-cloud", type: "float", domain: "positive float", defaultValue: 18.0, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dtm","value":true},{"kind":"option","name":"pc-classify","value":true}]}], costTag: null, affects: ["ground-model","point-cloud"], locked: null },
  { name: "mesh-size", bin: "shown", group: "mesh-and-texture", type: "int", domain: "positive integer", defaultValue: 200000, presets: {}, dependencies: [], costTag: null, affects: ["3d-model"], locked: null },
  { name: "mesh-octree-depth", bin: "shown", group: "mesh-and-texture", type: "int", domain: "integer: 1 <= x <= 14", defaultValue: 11, presets: {}, dependencies: [], costTag: null, affects: ["3d-model"], locked: null },
  { name: "use-3dmesh", bin: "shown", group: "mesh-and-texture", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "processing-time", affects: ["time","orthophoto","3d-model"], locked: null },
  { name: "skip-3dmodel", bin: "shown", group: "mesh-and-texture", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "processing-time", affects: ["time","3d-model"], locked: null },
  { name: "texturing-skip-global-seam-leveling", bin: "shown", group: "mesh-and-texture", type: "bool", domain: "", defaultValue: false, presets: {"multispectral-map":true}, dependencies: [], costTag: null, affects: ["orthophoto","3d-model"], locked: null },
  { name: "texturing-keep-unseen-faces", bin: "shown", group: "mesh-and-texture", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","3d-model"], locked: null },
  { name: "texturing-single-material", bin: "shown", group: "mesh-and-texture", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["3d-model"], locked: null },
  { name: "dsm", bin: "shown", group: "elevation-models", type: "bool", domain: "", defaultValue: false, presets: {"map-with-heights":true,"ground-model":true}, dependencies: [], costTag: null, affects: ["surface-model","report"], locked: null },
  { name: "dtm", bin: "shown", group: "elevation-models", type: "bool", domain: "", defaultValue: false, presets: {"ground-model":true}, dependencies: [], costTag: null, affects: ["ground-model","point-cloud","report"], locked: null },
  { name: "dem-resolution", bin: "shown", group: "elevation-models", type: "float", domain: "float", defaultValue: 5, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dsm","value":true},{"kind":"option","name":"dtm","value":true}]}], costTag: null, affects: ["quality","surface-model","ground-model"], locked: null },
  { name: "dem-gapfill-steps", bin: "shown", group: "elevation-models", type: "int", domain: "positive integer", defaultValue: 3, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dsm","value":true},{"kind":"option","name":"dtm","value":true}]}], costTag: null, affects: ["surface-model","ground-model"], locked: null },
  { name: "dem-decimation", bin: "shown", group: "elevation-models", type: "int", domain: "positive integer", defaultValue: 1, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dsm","value":true},{"kind":"option","name":"dtm","value":true}]}], costTag: "processing-time", affects: ["quality","time","surface-model","ground-model"], locked: null },
  { name: "dem-euclidean-map", bin: "shown", group: "elevation-models", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [{"kind":"any","alternatives":[{"kind":"option","name":"dsm","value":true},{"kind":"option","name":"dtm","value":true}]}], costTag: null, affects: ["surface-model","ground-model"], locked: null },
  { name: "fast-orthophoto", bin: "shown", group: "orthophoto", type: "bool", domain: "", defaultValue: false, presets: {"quick-map":true}, dependencies: [], costTag: "processing-time", affects: ["time","orthophoto","point-cloud","3d-model","report"], locked: null },
  { name: "skip-orthophoto", bin: "shown", group: "orthophoto", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "processing-time", affects: ["time","orthophoto"], locked: null },
  { name: "orthophoto-resolution", bin: "shown", group: "orthophoto", type: "float", domain: "float > 0.0", defaultValue: 5, presets: {}, dependencies: [], costTag: null, affects: ["quality","orthophoto"], locked: null },
  { name: "crop", bin: "shown", group: "orthophoto", type: "float", domain: "positive float", defaultValue: 3, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud","report"], locked: null },
  { name: "boundary", bin: "shown", group: "orthophoto", type: "string", domain: "json", defaultValue: "", presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud","3d-model","report"], locked: null },
  { name: "auto-boundary", bin: "shown", group: "orthophoto", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud","3d-model"], locked: null },
  { name: "auto-boundary-distance", bin: "shown", group: "orthophoto", type: "float", domain: "positive float", defaultValue: 0, presets: {}, dependencies: [{"kind":"option","name":"auto-boundary","value":true}], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud","3d-model"], locked: null },
  { name: "orthophoto-cutline", bin: "shown", group: "orthophoto", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "orthophoto-png", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "orthophoto-kmz", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "orthophoto-compression", bin: "shown", group: "outputs-and-formats", type: "enum", domain: ["JPEG","LZW","PACKBITS","DEFLATE","LZMA","NONE"], defaultValue: "DEFLATE", presets: {}, dependencies: [], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "orthophoto-no-tiled", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto"], locked: null },
  { name: "cog", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model"], locked: "always-on" },
  { name: "tiles", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model"], locked: null },
  { name: "pc-las", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: null },
  { name: "pc-csv", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: null },
  { name: "pc-copc", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: null },
  { name: "pc-ept", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["point-cloud"], locked: "always-on" },
  { name: "gltf", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["3d-model"], locked: "always-on" },
  { name: "3d-tiles", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["3d-model"], locked: null },
  { name: "skip-report", bin: "shown", group: "outputs-and-formats", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "processing-time", affects: ["time","report"], locked: null },
  { name: "report-units", bin: "shown", group: "outputs-and-formats", type: "enum", domain: ["m","ft","US survey foot"], defaultValue: "m", presets: {}, dependencies: [], costTag: null, affects: ["report"], locked: null },
  { name: "max-concurrency", bin: "shown", group: "performance-and-limits", type: "int", domain: "positive integer", defaultValue: 8, presets: {}, dependencies: [], costTag: null, affects: ["time","memory"], locked: null, machineDefault: true },
  { name: "no-gpu", bin: "shown", group: "performance-and-limits", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["time"], locked: null },
  { name: "optimize-disk-space", bin: "shown", group: "performance-and-limits", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "disk-space", affects: ["disk"], locked: null },
  { name: "ignore-gsd", bin: "shown", group: "performance-and-limits", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: "processing-time-and-memory", affects: ["quality","time","memory","orthophoto","surface-model","ground-model"], locked: null },
  { name: "end-with", bin: "shown", group: "expert", type: "enum", domain: ["dataset","split","merge","opensfm","openmvs","odm_filterpoints","odm_meshing","mvs_texturing","odm_georeferencing","odm_dem","odm_orthophoto","odm_report","odm_postprocess"], defaultValue: "odm_postprocess", presets: {}, dependencies: [], costTag: null, affects: ["time","orthophoto","surface-model","ground-model","point-cloud","3d-model","report"], locked: null },
  { name: "rerun-from", bin: "shown", group: "expert", type: "enum", domain: ["","dataset","split","merge","opensfm","openmvs","odm_filterpoints","odm_meshing","mvs_texturing","odm_georeferencing","odm_dem","odm_orthophoto","odm_report","odm_postprocess"], defaultValue: "", presets: {}, dependencies: [], costTag: null, affects: ["time"], locked: null },
  { name: "split", bin: "shown", group: "expert", type: "int", domain: "positive integer", defaultValue: 999999, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud"], locked: null },
  { name: "split-overlap", bin: "shown", group: "expert", type: "float", domain: "positive integer", defaultValue: 150, presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud"], locked: null },
  { name: "sm-cluster", bin: "shown", group: "expert", type: "string", domain: "string", defaultValue: "None", presets: {}, dependencies: [], costTag: null, affects: ["time"], locked: null },
  { name: "sm-no-align", bin: "shown", group: "expert", type: "bool", domain: "", defaultValue: false, presets: {}, dependencies: [], costTag: null, affects: ["quality"], locked: null },
  { name: "merge", bin: "shown", group: "expert", type: "enum", domain: ["all","pointcloud","orthophoto","dem"], defaultValue: "all", presets: {}, dependencies: [], costTag: null, affects: ["orthophoto","surface-model","ground-model","point-cloud"], locked: null },
  { name: "project-path", bin: "not-offered" },
  { name: "name", bin: "not-offered" },
  { name: "rerun", bin: "not-offered" },
  { name: "rerun-all", bin: "not-offered" },
  { name: "version", bin: "not-offered" },
  { name: "copy-to", bin: "not-offered" },
  { name: "gcp", bin: "not-offered" },
  { name: "geo", bin: "not-offered" },
  { name: "align", bin: "not-offered" },
  { name: "split-image-groups", bin: "not-offered" },
];
