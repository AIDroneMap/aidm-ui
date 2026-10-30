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
  wayIn: "upload" | "import";
  photos: { included: number; excluded: number; total: number; bytes: number };
  facts: ProjectPhotoFactsView;
  options: ReviewOption[];
  outputs: RunOutput[];
  alwaysProduced: Array<(typeof SERVER_OUTPUT_KEYS)[number]>;
  revision: string;
  blocked: ApiError | null;
}

export interface ProjectRunRequest {
  engineId: number;
  preset: PresetId;
  name: string;
  revision: string;
}
