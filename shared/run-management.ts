import type { RunView } from "./api-types.ts";
import type { SettingValue } from "./settings-file.ts";

export interface RunSeed {
  id: number;
  engineId: number | null;
  name: string | null;
  preset: string | null;
  presetName?: string;
  options: SettingValue[];
}
export interface ProjectRunsView { runs: RunView[]; nextOffset: number | null }
