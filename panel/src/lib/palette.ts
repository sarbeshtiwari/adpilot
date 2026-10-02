/**
 * Chart colours. Both columns are selected and validated against their own
 * surface (validate_palette.js — all checks pass, light/dark).
 * Slots are assigned by entity in a fixed order and never cycled.
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const;

/** One hue, light → dark, for magnitude (bar lists, heat cells). */
export const SEQ_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
export const SEQ_DARK = ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#5598e7', '#86b6ef'];

export function seriesColors(dark: boolean) {
  return dark ? SERIES_DARK : SERIES_LIGHT;
}

export function sequential(dark: boolean, t: number) {
  const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
  return ramp[i];
}
