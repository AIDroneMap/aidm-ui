// The sample dataset, pinned exactly as in the engine's CI
// (AIDroneMap/aidm, scripts/smoke-test.conf on the branch that adds it).

export interface ReferenceTime {
  /** process.arch of the machine the time applies to. */
  architecture: "x64" | "arm64";
  seconds: number;
  cores: number;
  memoryGiB: number;
}

export interface SampleDatasetEntry {
  name: string;
  url: string;
  /** Bytes of the zip. */
  size: number;
  sha256: string;
  imageCount: number;
  licence: string;
  licenceUrl: string;
  attribution: string;
  /** File name of the zip in the data folder. */
  fileName: string;
  referenceTimes: ReferenceTime[];
  /** The engine options of the run, the same as the engine's CI. */
  options: Array<{ name: string; value: unknown }>;
}

export const SAMPLE_DATASET: SampleDatasetEntry = {
  name: "aidm-vineyard-small",
  url:
    "https://huggingface.co/datasets/AIDroneMap/aidm-vineyard-small/resolve/" +
    "6af198c9a327e187e088ede6d7c632eb77b50eaa/aidm-vineyard-small-v1.zip",
  size: 888_735_308,
  sha256: "db6feb86d55ab580782bf85193cc3e0393fe3f16aa36ec7b15f3d11a6456752f",
  imageCount: 73,
  licence: "CC BY 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "AIDroneMap, provided by ITALDRONI",
  fileName: "aidm-vineyard-small-v1.zip",
  // Measured by the engine's first CI run on this dataset (AIDroneMap/aidm,
  // workflow run 40264899952) on GitHub-hosted runners with 4 cores and
  // 15 GiB of RAM. These are the only times the interface may show.
  referenceTimes: [
    { architecture: "x64", seconds: 1366, cores: 4, memoryGiB: 15 },
    { architecture: "arm64", seconds: 982, cores: 4, memoryGiB: 15 },
  ],
  options: [{ name: "dsm", value: true }],
};
