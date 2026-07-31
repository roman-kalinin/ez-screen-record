import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-components';

/**
 * Windows 11 native look for Fluent v9.
 *
 * Fluent ships no Windows theme — only web/Teams variants — and `webDarkTheme`
 * is noticeably lighter and flatter than the real thing (its
 * colorNeutralBackground1 is #292929 against Windows' #202020). These overrides
 * pull the surface colours from WinUI's own theme resources so the app reads as
 * native rather than "web app in a window".
 *
 * The card backgrounds are deliberately translucent white rather than solid:
 * that is what lets the Mica backdrop show through, which is most of the
 * "native Windows 11" impression.
 */

/** Fallback accent when the system colour can't be read (Windows blue). */
const DEFAULT_ACCENT = '#0078d4';

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace('#', '').slice(0, 6);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) =>
    lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Lightness stops for the 16-step Fluent brand ramp. */
const RAMP_LIGHTNESS = [
  9, 14, 19, 23, 28, 33, 39, 45, 51, 57, 63, 70, 76, 82, 88, 94,
] as const;

/** Build a Fluent brand ramp from a single accent colour. */
export function brandRampFromAccent(accentHex: string): BrandVariants {
  const { h, s } = hexToHsl(accentHex || DEFAULT_ACCENT);
  // Clamp saturation at both ends: greys produce a muddy ramp, while fully
  // saturated accents (the user's #5e0074 is s=100) blow out to neon at the
  // lighter stops — Windows' own accent palette never goes above ~85%.
  const sat = Math.min(Math.max(s, 20), 85);
  const keys = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
  const ramp = {} as Record<number, string>;
  keys.forEach((key, i) => {
    ramp[key] = hslToHex(h, sat, RAMP_LIGHTNESS[i]);
  });
  return ramp as unknown as BrandVariants;
}

/** WinUI type ramp — Segoe UI Variable resolves per optical size. */
const FONT_TEXT =
  "'Segoe UI Variable Text', 'Segoe UI Variable Static Text', 'Segoe UI', system-ui, sans-serif";
const FONT_DISPLAY =
  "'Segoe UI Variable Display', 'Segoe UI Variable Static Display', 'Segoe UI', system-ui, sans-serif";

/** Surface colours lifted from WinUI's Common_themeresources_any.xaml. */
const winDarkSurfaces = {
  // Opaque throughout: Mica is disabled (it breaks content protection), so
  // there is nothing to show through and translucent surfaces would only hurt
  // legibility. These are WinUI's solid dark values.
  colorNeutralBackground1: '#272727',
  colorNeutralBackground1Hover: '#2f2f2f',
  colorNeutralBackground1Pressed: '#242424',
  colorNeutralBackground2: '#242424',
  // SolidBackgroundFillColorBase.
  colorNeutralBackground3: '#202020',
  colorNeutralBackground4: '#2d2d2d',
  colorNeutralBackground4Hover: '#353535',
  colorNeutralStroke1: 'rgba(255,255,255,0.07)',
  colorNeutralStroke2: 'rgba(255,255,255,0.05)',
  colorNeutralForeground2: 'rgba(255,255,255,0.77)',
  colorNeutralForeground3: 'rgba(255,255,255,0.53)',
  // Flyout surfaces (menus, dropdowns, tooltips) must be OPAQUE. The card
  // colours above are translucent so Mica shows through the window, but a
  // translucent menu floating over arbitrary content is unreadable.
  // WinUI uses AcrylicBackgroundFillColorDefault here; a solid equivalent
  // is both clearer and cheaper.
  colorNeutralBackgroundStatic: '#2c2c2c',
  colorNeutralBackground6: '#2c2c2c',
  colorNeutralBackgroundAlpha: '#2c2c2c',
  colorNeutralBackgroundAlpha2: '#2c2c2c',
  colorSubtleBackground: 'transparent',
};

const winLightSurfaces = {
  colorNeutralBackground1: '#ffffff',
  colorNeutralBackground1Hover: '#f6f6f6',
  colorNeutralBackground1Pressed: '#f0f0f0',
  colorNeutralBackground2: '#f9f9f9',
  colorNeutralBackground3: '#f3f3f3',
  colorNeutralBackground4: '#ededed',
  colorNeutralBackground4Hover: '#e5e5e5',
  colorNeutralStroke1: 'rgba(0,0,0,0.06)',
  colorNeutralStroke2: 'rgba(0,0,0,0.04)',
  colorNeutralForeground2: 'rgba(0,0,0,0.79)',
  colorNeutralForeground3: 'rgba(0,0,0,0.55)',
};

/** WinUI geometry: 4px controls/cards, 8px flyouts. */
const winGeometry = {
  borderRadiusSmall: '4px',
  borderRadiusMedium: '4px',
  borderRadiusLarge: '8px',
  borderRadiusXLarge: '8px',
  fontFamilyBase: FONT_TEXT,
};

export function buildTheme(accentHex: string, dark: boolean): Theme {
  const ramp = brandRampFromAccent(accentHex);
  const base = dark ? createDarkTheme(ramp) : createLightTheme(ramp);
  return {
    ...base,
    ...(dark ? winDarkSurfaces : winLightSurfaces),
    ...winGeometry,
  };
}

export { FONT_TEXT, FONT_DISPLAY, DEFAULT_ACCENT };
