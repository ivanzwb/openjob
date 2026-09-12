import type { RubricAnchors } from '@core/plugins/types';

export function anchors(
  one: string,
  two: string,
  three: string,
  four: string,
  five: string,
): RubricAnchors {
  return { 1: one, 2: two, 3: three, 4: four, 5: five };
}
