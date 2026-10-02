/**
 * Curated font lists for the "font may be missing on the presenting computer" check
 * (checks/fontAvailability.ts). Deliberately conservative: a font belongs in
 * `OFFICE_CROSS_PLATFORM_FONTS` only when a Microsoft 365 install puts it on BOTH Windows and Mac.
 * Anything left out is reported as "may be missing", which a team can silence per font with the
 * show-machine font list (`AuditOptions.availableFonts`).
 *
 * Sources:
 * - Microsoft typography font library (per-font "products" lists):
 *   https://learn.microsoft.com/en-us/typography/font-list/
 * - Cloud fonts in Office (fonts Microsoft 365 downloads on demand, Windows and Mac 16.17+):
 *   https://support.microsoft.com/en-us/office/fonts/cloud-fonts-in-office
 *
 * Cloud fonts are only downloaded when the computer is online and "optional connected experiences"
 * are enabled, so a cloud-only font is NOT treated as safe for an offline show machine, with one
 * exception: the Aptos family, the Microsoft 365 default theme font since 2023, which Microsoft 365
 * provisions on both platforms. Entries marked `cloud: true` are cloud fonts that download on
 * demand where not already present, so the summary flags them for offline show machines.
 */

export interface OfficeFont {
  name: string;
  /** Delivered as a Microsoft 365 cloud font (downloads on demand) rather than always preinstalled. */
  cloud?: boolean;
}

const APTOS = ["Aptos", "Aptos Display", "Aptos Narrow", "Aptos Serif", "Aptos Mono", "Aptos Light", "Aptos SemiBold", "Aptos ExtraBold", "Aptos Black"];

/** Fonts installed with Microsoft 365 on both Windows and Mac (Segoe UI is NOT here: Windows only). */
export const OFFICE_CROSS_PLATFORM_FONTS: readonly OfficeFont[] = [
  { name: "Arial" },
  { name: "Arial Black" },
  { name: "Calibri" },
  { name: "Calibri Light" },
  { name: "Cambria" },
  { name: "Cambria Math" },
  { name: "Candara" },
  { name: "Comic Sans MS" },
  { name: "Consolas" },
  { name: "Constantia" },
  { name: "Corbel" },
  { name: "Courier New" },
  { name: "Franklin Gothic Medium" },
  { name: "Gabriola" },
  { name: "Georgia" },
  { name: "Impact" },
  { name: "Lucida Console" },
  { name: "Palatino Linotype" },
  { name: "Tahoma" },
  { name: "Times New Roman" },
  { name: "Trebuchet MS" },
  { name: "Verdana" },
  { name: "Wingdings" },
  { name: "Symbol" },
  { name: "Webdings" },
  ...APTOS.map((name): OfficeFont => ({ name, cloud: true })),
];

const OFFICE_INDEX = new Map(OFFICE_CROSS_PLATFORM_FONTS.map((f) => [f.name.toLowerCase(), f]));

/** The cross-platform Office font entry for `typeface` (case-insensitive), if any. */
export function officeCrossPlatformFont(typeface: string): OfficeFont | undefined {
  return OFFICE_INDEX.get(typeface.trim().toLowerCase());
}

export type FontPlatform = "windows" | "mac";

export interface PlatformOnlyFont {
  /** The one platform where the font is standard. */
  platform: FontPlatform;
  /** Microsoft 365 can download it on demand (cloud font) on the other platform when online. */
  cloud: boolean;
}

// Fonts standard on one platform only. Windows East Asian UI/text fonts (and their localized
// family names) ship with Windows; most are Microsoft 365 cloud fonts on Mac. Mac system fonts are
// not available on Windows at all.
const WINDOWS_CLOUD = [
  "Segoe UI",
  "Segoe UI Light",
  "Segoe UI Semilight",
  "Segoe UI Semibold",
  "Segoe UI Black",
  "MS Gothic",
  "MS PGothic",
  "MS UI Gothic",
  "MS Mincho",
  "MS PMincho",
  "Yu Gothic",
  "Yu Gothic UI",
  "Yu Gothic Light",
  "Yu Gothic Medium",
  "Yu Mincho",
  "Meiryo",
  "Meiryo UI",
  "SimSun",
  "NSimSun",
  "SimHei",
  "Microsoft YaHei",
  "Microsoft YaHei UI",
  "DengXian",
  "DengXian Light",
  "KaiTi",
  "FangSong",
  "Microsoft JhengHei",
  "PMingLiU",
  "MingLiU",
  "Malgun Gothic",
  "Gulim",
  "Dotum",
  "Batang",
  "Gungsuh",
  // Localized family names PowerPoint writes for the same fonts.
  "游ゴシック",
  "游ゴシック Light",
  "游ゴシック Medium",
  "游明朝",
  "ＭＳ ゴシック",
  "ＭＳ Ｐゴシック",
  "ＭＳ 明朝",
  "ＭＳ Ｐ明朝",
  "メイリオ",
  "宋体",
  "新宋体",
  "黑体",
  "微软雅黑",
  "等线",
  "等线 Light",
  "楷体",
  "仿宋",
  "微軟正黑體",
  "新細明體",
  "細明體",
  "맑은 고딕",
  "굴림",
  "돋움",
  "바탕",
  "궁서",
];

const MAC_ONLY = [
  "Hiragino Sans",
  "Hiragino Sans GB",
  "Hiragino Kaku Gothic Pro",
  "Hiragino Kaku Gothic ProN",
  "Hiragino Kaku Gothic StdN",
  "Hiragino Maru Gothic Pro",
  "Hiragino Maru Gothic ProN",
  "Hiragino Mincho Pro",
  "Hiragino Mincho ProN",
  "PingFang SC",
  "PingFang TC",
  "PingFang HK",
  "Heiti SC",
  "Heiti TC",
  "STHeiti",
  "Songti SC",
  "Songti TC",
  "STSong",
  "Apple SD Gothic Neo",
  "AppleGothic",
  "AppleMyungjo",
  "Osaka",
  "Helvetica",
  "Helvetica Neue",
  "SF Pro",
  "SF Pro Display",
  "SF Pro Text",
  ".AppleSystemUIFont",
  "Avenir",
  "Avenir Next",
  "Menlo",
  "Monaco",
  "Lucida Grande",
  "Geneva",
  "Optima",
];

const PLATFORM_INDEX = new Map<string, PlatformOnlyFont>([
  ...WINDOWS_CLOUD.map((n): [string, PlatformOnlyFont] => [n.toLowerCase(), { platform: "windows", cloud: true }]),
  ...MAC_ONLY.map((n): [string, PlatformOnlyFont] => [n.toLowerCase(), { platform: "mac", cloud: false }]),
]);

/** Localized Mac family-name prefixes (e.g. "ヒラギノ角ゴ ProN W3"). */
const MAC_PREFIXES = ["hiragino ", "ヒラギノ"];

/** Platform note for a font that is standard on one platform only, if it is one. */
export function platformOnlyFont(typeface: string): PlatformOnlyFont | undefined {
  const k = typeface.trim().toLowerCase();
  const hit = PLATFORM_INDEX.get(k);
  if (hit) return { ...hit };
  if (MAC_PREFIXES.some((p) => k.startsWith(p))) return { platform: "mac", cloud: false };
  return undefined;
}

/** Common cross-platform stand-ins for well-known non-Office fonts (lower-case key). */
const REPLACEMENTS: Record<string, string> = {
  "segoe ui": "Arial",
  "segoe ui light": "Arial",
  "segoe ui semibold": "Arial",
  helvetica: "Arial",
  "helvetica neue": "Arial",
  "sf pro": "Arial",
  "sf pro display": "Arial",
  "sf pro text": "Arial",
  "lucida grande": "Verdana",
  geneva: "Verdana",
  avenir: "Arial",
  "avenir next": "Arial",
  gotham: "Arial",
  roboto: "Arial",
  "open sans": "Arial",
  lato: "Arial",
  montserrat: "Arial",
  "source sans pro": "Arial",
  menlo: "Consolas",
  monaco: "Consolas",
  garamond: "Georgia",
  "times": "Times New Roman",
};

/** A suggested standard replacement for a well-known font, if one is known. */
export function suggestedReplacement(typeface: string): string | undefined {
  return REPLACEMENTS[typeface.trim().toLowerCase()];
}
