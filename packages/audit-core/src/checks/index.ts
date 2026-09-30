/**
 * The check registry. Each area unit (U5–U9) adds its checks here; the runner runs them grouped
 * by area in `AREAS` order, then in this list's order within an area.
 */
import type { Check } from "../runner";

export const CHECKS: readonly Check[] = [];
