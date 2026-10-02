/**
 * The check registry. The runner runs checks grouped by area in `AREAS` order, then in this list's
 * order within an area.
 */
import type { Check } from "../runner";
import { colorChecks } from "./colors";
import { fontAvailabilityChecks } from "./fontAvailability";
import { fontChecks } from "./fonts";
import { layoutChecks } from "./layout";
import { linkChecks } from "./links";
import { masterChecks } from "./masters";
import { mediaChecks } from "./media";
import { playbackChecks } from "./playback";
import { reviewChecks } from "./review";
import { titleNumberChecks } from "./titlesNumbers";

export const CHECKS: readonly Check[] = [
  ...fontChecks,
  ...fontAvailabilityChecks,
  ...titleNumberChecks,
  ...colorChecks,
  ...mediaChecks,
  ...playbackChecks,
  ...masterChecks,
  ...linkChecks,
  ...reviewChecks,
  ...layoutChecks,
];

export {
  colorChecks,
  fontAvailabilityChecks,
  fontChecks,
  layoutChecks,
  linkChecks,
  masterChecks,
  mediaChecks,
  playbackChecks,
  reviewChecks,
  titleNumberChecks,
};
