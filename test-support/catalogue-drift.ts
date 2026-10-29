import type { ReconciledOption } from "../shared/engine-options.ts";
import { OPTION_CATALOGUE } from "../shared/option-catalogue.ts";

// API 2.6.1 ships an older test fixture. Keep this exception exact so that a
// refreshed fixture or any further drift fails the test instead of spreading.
// Source: https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/tests/odm_options.json
const TEST_MODE_261 = {
  missing: ["gps-z-offset", "matcher-order", "report-units", "sfm-no-partial"],
  unexplained: ["build-overviews", "pc-rectify", "pc-tile", "texturing-skip-local-seam-leveling"],
};

/** Checks the option route, including its exact legacy test-mode exception. */
export function assertCatalogueDrift(options: readonly ReconciledOption[], apiVersion: string): void {
  const names = new Set(options.map((option) => option.name));
  const actual = {
    missing: OPTION_CATALOGUE.filter((option) => option.bin === "shown" && !names.has(option.name)).map((option) => option.name).sort(),
    unexplained: options.filter((option) => option.unexplained).map((option) => option.name).sort(),
  };
  const expected = apiVersion === "2.6.1" ? TEST_MODE_261 : { missing: [], unexplained: [] };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Catalogue drift for API ${apiVersion}: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}
