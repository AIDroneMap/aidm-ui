import type { ReconciledOption } from "./engine-options.ts";
import type { SettingsFacts } from "./run-settings.ts";
import type { ApiError } from "./api-error.ts";
import type { EngineInfoView, ProjectPhotoFactsView } from "./api-types.ts";
import type { OptionValue, PresetId } from "./option-catalogue.ts";
import type { RunOutput, SERVER_OUTPUT_KEYS } from "./run-plan.ts";

export interface ReviewOption {
  name: string;
  value: OptionValue;
  defaultValue: OptionValue;
  help: string;
  unexplained: boolean;
}

export interface RunReviewView {
  presetName?: string;
  project: { id: number; name: string };
  engine: {
    id: number;
    name: string;
    kind: "local" | "remote";
    info: EngineInfoView;
    gpu: boolean | null;
    imageLimit: number | null;
    imageLimitReported: boolean;
  };
  preset: PresetId;
  presets: Array<{ id: PresetId; departures: ReviewOption[] }>;
  wayIn: "upload" | "import" | "link";
  photos: { included: number | null; excluded: number | null; total: number | null; bytes: number | null };
  facts: ProjectPhotoFactsView | null;
  options: ReviewOption[];
  outputs: RunOutput[];
  alwaysProduced: Array<(typeof SERVER_OUTPUT_KEYS)[number]>;
  revision: string;
  blocked: ApiError | null;
  settings?: { options: ReconciledOption[]; facts: SettingsFacts; matcherWarning: string | null };
}

export interface ProjectRunRequest {
  presetName?: string;
  engineId: number;
  preset: PresetId;
  name: string;
  revision: string;
  options?: Array<{ name: string; value: OptionValue }>;
}
