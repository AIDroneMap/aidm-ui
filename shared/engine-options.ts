import type { ShownOption } from "./option-catalogue.ts";

/** Facts returned by the task API's documented /options endpoint. */
export interface EngineOption {
  name: string;
  type: "int" | "float" | "string" | "bool" | "enum";
  value: string;
  domain: string | Array<string | number | boolean>;
  help: string;
}

/** Settings facts for one engine. Only an unexplained option carries engine help. */
export interface ReconciledOption extends Omit<ShownOption, "domain"> {
  domain: EngineOption["domain"];
  unexplained: boolean;
  changes: Array<"type" | "domain" | "defaultValue">;
  help?: string;
}
