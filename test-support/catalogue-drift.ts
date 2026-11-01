import type { ReconciledOption } from "../shared/engine-options.ts";
import { OPTION_CATALOGUE } from "../shared/option-catalogue.ts";

// API 2.6.1 and the 2.7.0 release candidate ship the same older test fixture. Keep this exception exact so that a
// refreshed fixture or any further drift fails the test instead of spreading.
// Source: https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/tests/odm_options.json
// Identical Git blob at 2.7.0 candidate cea190a4: 7b897173fddd91a5165424fcce7c2f00cfb6c69b.
const LEGACY_TEST_OPTIONS = {
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
  const expected = (apiVersion === "2.6.1" || apiVersion === "2.7.0") ? LEGACY_TEST_OPTIONS : { missing: [], unexplained: [] };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Catalogue drift for API ${apiVersion}: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}
