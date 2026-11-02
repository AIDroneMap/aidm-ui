import type { ReconciledOption } from "../shared/engine-options.ts";
import { OPTION_CATALOGUE } from "../shared/option-catalogue.ts";

// The test-mode packages of API 2.6.1 and 2.7.0 bundle the same older option list, so a check
// against a test-mode API sees the same differences whichever version serves it. Keep this
// exception exact so that a refreshed fixture or any further drift fails the test instead of
// spreading.
// Source: https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/tests/odm_options.json
// Identical Git blob in the 2.7.0 package: 7b897173fddd91a5165424fcce7c2f00cfb6c69b.
const LEGACY_TEST_OPTIONS = {
  missing: ["gps-z-offset", "matcher-order", "report-units", "sfm-no-partial"],
  unexplained: ["build-overviews", "pc-rectify", "pc-tile", "texturing-skip-local-seam-leveling"],
};

/** Which option list a check ran against: one bundled by a test-mode package, or one a real engine reported. */
export type OptionListKind = "test-mode" | "engine";

/** Checks the option route against the exact exception its kind of list is allowed to carry. */
export function assertCatalogueDrift(options: readonly ReconciledOption[], apiVersion: string, list: OptionListKind): void {
  const names = new Set(options.map((option) => option.name));
  const actual = {
    missing: OPTION_CATALOGUE.filter((option) => option.bin === "shown" && !names.has(option.name)).map((option) => option.name).sort(),
    unexplained: options.filter((option) => option.unexplained).map((option) => option.name).sort(),
  };
  const expected = list === "test-mode" ? LEGACY_TEST_OPTIONS : { missing: [], unexplained: [] };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Catalogue drift for the ${list} list of API ${apiVersion}: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}
