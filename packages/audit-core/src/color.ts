/**
 * Color math for the Colors area (U6): hex parsing, sRGB → CIE Lab (D65), CIEDE2000, and the
 * DrawingML color forms that carry a literal value (preset names, HSL, scRGB).
 *
 * Color transforms (`a:lumMod`, `a:tint`, …) are deliberately not applied: literal detection
 * reports the base value as written.
 */

export interface Rgb {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/**
 * Parses `#RRGGBB`, `RRGGBB`, `#RGB`, or `RGB` (any case, surrounding whitespace ignored) into
 * upper-case `RRGGBB`. Returns undefined for anything else.
 */
export function parseHex(input: string): string | undefined {
  const s = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return s
      .split("")
      .map((c) => c + c)
      .join("")
      .toUpperCase();
  }
  return undefined;
}

/** `hex` must be upper/lower `RRGGBB` without `#` (use `parseHex` first for user input). */
export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

const clampByte = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

export function rgbToHex({ r, g, b }: Rgb): string {
  return [r, g, b].map((v) => clampByte(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (v: number): number => {
  const c = Math.min(1, Math.max(0, v));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
};

// D65 reference white (2° observer), as used by sRGB.
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

export function rgbToLab({ r, g, b }: Rgb): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN;
  const y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / YN;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / ZN;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function hexToLab(hex: string): Lab {
  return rgbToLab(hexToRgb(hex));
}

const deg = (rad: number): number => (rad * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;

/**
 * CIEDE2000 color difference (kL = kC = kH = 1), following Sharma, Wu & Dalal (2005).
 */
export function ciede2000(c1: Lab, c2: Lab): number {
  const { L: L1, a: a1, b: b1 } = c1;
  const { L: L2, a: a2, b: b2 } = c2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (b: number, ap: number): number => {
    if (b === 0 && ap === 0) return 0;
    const h = deg(Math.atan2(b, ap));
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const Lm = (Lbarp - 50) ** 2;
  const Sl = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  const tl = dLp / Sl;
  const tc = dCp / Sc;
  const th = dHp / Sh;
  return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
}

const labCache = new Map<string, Lab>();

/** CIEDE2000 distance between two `RRGGBB` colors. 0 exactly when the hex values are equal. */
export function colorDistance(hex1: string, hex2: string): number {
  const h1 = hex1.toUpperCase();
  const h2 = hex2.toUpperCase();
  if (h1 === h2) return 0;
  const lab = (h: string): Lab => {
    let v = labCache.get(h);
    if (!v) {
      v = hexToLab(h);
      if (labCache.size > 4096) labCache.clear();
      labCache.set(h, v);
    }
    return v;
  };
  return ciede2000(lab(h1), lab(h2));
}

/** The candidate nearest to `hex` by CIEDE2000; ties keep the first candidate. */
export function nearestColor<T extends { hex: string }>(
  hex: string,
  candidates: readonly T[],
): { item: T; distance: number } | undefined {
  let best: { item: T; distance: number } | undefined;
  for (const c of candidates) {
    const d = colorDistance(hex, c.hex);
    if (!best || d < best.distance) best = { item: c, distance: d };
  }
  return best;
}

/**
 * Common `a:prstClr` values (ST_PresetColorVal) → RRGGBB. Covers the basic names and their
 * `dk`/`lt`/`med` variants PowerPoint emits; unknown presets resolve to undefined.
 */
export const PRESET_COLORS: Readonly<Record<string, string>> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  aqua: "00FFFF",
  magenta: "FF00FF",
  fuchsia: "FF00FF",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  maroon: "800000",
  olive: "808000",
  lime: "00FF00",
  teal: "008080",
  navy: "000080",
  purple: "800080",
  orange: "FFA500",
  pink: "FFC0CB",
  brown: "A52A2A",
  gold: "FFD700",
  violet: "EE82EE",
  indigo: "4B0082",
  darkGray: "A9A9A9",
  dkGray: "A9A9A9",
  darkGrey: "A9A9A9",
  dkGrey: "A9A9A9",
  lightGray: "D3D3D3",
  ltGray: "D3D3D3",
  lightGrey: "D3D3D3",
  ltGrey: "D3D3D3",
  dimGray: "696969",
  darkBlue: "00008B",
  dkBlue: "00008B",
  darkRed: "8B0000",
  dkRed: "8B0000",
  darkGreen: "006400",
  dkGreen: "006400",
  darkCyan: "008B8B",
  dkCyan: "008B8B",
  darkMagenta: "8B008B",
  dkMagenta: "8B008B",
  darkOrange: "FF8C00",
  dkOrange: "FF8C00",
  darkViolet: "9400D3",
  dkViolet: "9400D3",
  lightBlue: "ADD8E6",
  ltBlue: "ADD8E6",
  lightGreen: "90EE90",
  ltGreen: "90EE90",
  lightYellow: "FFFFE0",
  ltYellow: "FFFFE0",
  lightCyan: "E0FFFF",
  ltCyan: "E0FFFF",
  lightPink: "FFB6C1",
  ltPink: "FFB6C1",
  mediumBlue: "0000CD",
  medBlue: "0000CD",
  skyBlue: "87CEEB",
  steelBlue: "4682B4",
  royalBlue: "4169E1",
  crimson: "DC143C",
  tomato: "FF6347",
  coral: "FF7F50",
  salmon: "FA8072",
  tan: "D2B48C",
  beige: "F5F5DC",
  khaki: "F0E68C",
  turquoise: "40E0D0",
  orchid: "DA70D6",
  plum: "DDA0DD",
  lavender: "E6E6FA",
  ivory: "FFFFF0",
  chocolate: "D2691E",
  forestGreen: "228B22",
  seaGreen: "2E8B57",
};

export function presetHex(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PRESET_COLORS, name) ? PRESET_COLORS[name] : undefined;
}

/**
 * `a:hslClr`: hue in 60,000ths of a degree, sat/lum in 1,000ths of a percent (100000 = 100%).
 */
export function hslToHex(hue: number, sat: number, lum: number): string {
  const h = (((hue / 60000) % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, sat / 100000));
  const l = Math.min(1, Math.max(0, lum / 100000));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

/** `a:scrgbClr`: linear-light components in 1,000ths of a percent (100000 = 1.0). */
export function scrgbToHex(r: number, g: number, b: number): string {
  return rgbToHex({ r: linearToSrgb(r / 100000), g: linearToSrgb(g / 100000), b: linearToSrgb(b / 100000) });
}
