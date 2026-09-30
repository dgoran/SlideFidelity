/**
 * The check registry. The runner runs checks grouped by area in `AREAS` order, then in this list's
 * order within an area.
 */
import type { Check } from "../runner";
import { colorChecks } from "./colors";
import { fontChecks } from "./fonts";
import { linkChecks } from "./links";
import { masterChecks } from "./masters";
import { mediaChecks } from "./media";
import { reviewChecks } from "./review";

export const CHECKS: readonly Check[] = [
  ...fontChecks,
  ...colorChecks,
  ...mediaChecks,
  ...masterChecks,
  ...linkChecks,
  ...reviewChecks,
];

export { colorChecks, fontChecks, linkChecks, masterChecks, mediaChecks, reviewChecks };
