import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-components';
import { brandRampFromAccent } from './theme';

/**
 * Platform-conditional Fluent theme.
 *
 * Fluent v9 ships only web/Teams themes — there is no official "Windows" theme
 * and certainly no macOS one, so both surface sets below are derived from the
 * platforms' own theme resources.
 *
 * Using Fluent's *components* on macOS is a deliberate compromise: the
 * component behaviour and a11y are good, and re-skinning them via tokens gets
 * far closer to AppKit than any maintained macOS React library does. The
 * macOS-look libraries that exist (react-desktop, react-mac-ui) target High
 * Sierra/Windows 10 and are effectively abandoned; none auto-switch by
 * platform. So this is the pragmatic ceiling for a web UI.
 */

export type PlatformId = 'win32' | 'darwin' | 'linux';

/** Surfaces from WinUI's Common_themeresources_any.xaml. Translucent so Mica
 *  shows through — that translucency is most of the "Windows 11" impression. */
const winDark = {
  colorNeutralBackground1: 'rgba(255,255,255,0.05)',
  colorNeutralBackground1Hover: 'rgba(255,255,255,0.08)',
  colorNeutralBackground1Pressed: 'rgba(255,255,255,0.03)',
  colorNeutralBackground2: 'rgba(255,255,255,0.03)',
  colorNeutralBackground3: '#202020',
  colorNeutralBackground4: 'rgba(255,255,255,0.07)',
  colorNeutralStroke1: 'rgba(255,255,255,0.07)',
  colorNeutralStroke2: 'rgba(255,255,255,0.05)',
  colorNeutralForeground2: 'rgba(255,255,255,0.77)',
  colorNeutralForeground3: 'rgba(255,255,255,0.53)',
};

const winLight = {
  colorNeutralBackground1: 'rgba(255,255,255,0.70)',
  colorNeutralBackground1Hover: 'rgba(249,249,249,0.50)',
  colorNeutralBackground1Pressed: 'rgba(249,249,249,0.30)',
  colorNeutralBackground2: 'rgba(249,249,249,0.50)',
  colorNeutralBackground3: '#f3f3f3',
  colorNeutralBackground4: 'rgba(0,0,0,0.02)',
  colorNeutralStroke1: 'rgba(0,0,0,0.06)',
  colorNeutralStroke2: 'rgba(0,0,0,0.04)',
  colorNeutralForeground2: 'rgba(0,0,0,0.79)',
  colorNeutralForeground3: 'rgba(0,0,0,0.55)',
};

/**
 * macOS surfaces. Two things differ structurally from Windows:
 *  - Content sits on a *lighter* raised surface over the vibrancy, rather than
 *    Windows' translucent-card-over-Mica.
 *  - macOS separators are much fainter than WinUI strokes.
 */
const macDark = {
  colorNeutralBackground1: 'rgba(255,255,255,0.06)',
  colorNeutralBackground1Hover: 'rgba(255,255,255,0.10)',
  colorNeutralBackground1Pressed: 'rgba(255,255,255,0.14)',
  colorNeutralBackground2: 'rgba(255,255,255,0.03)',
  // Opaque fallback matching macOS dark window chrome.
  colorNeutralBackground3: '#1e1e1e',
  colorNeutralBackground4: 'rgba(255,255,255,0.08)',
  colorNeutralStroke1: 'rgba(255,255,255,0.10)',
  colorNeutralStroke2: 'rgba(255,255,255,0.06)',
  colorNeutralForeground1: 'rgba(255,255,255,0.85)',
  colorNeutralForeground2: 'rgba(255,255,255,0.55)',
  colorNeutralForeground3: 'rgba(255,255,255,0.25)',
};

const macLight = {
  colorNeutralBackground1: 'rgba(255,255,255,0.80)',
  colorNeutralBackground1Hover: 'rgba(0,0,0,0.04)',
  colorNeutralBackground1Pressed: 'rgba(0,0,0,0.08)',
  colorNeutralBackground2: 'rgba(255,255,255,0.55)',
  colorNeutralBackground3: '#ececec',
  colorNeutralBackground4: 'rgba(0,0,0,0.03)',
  colorNeutralStroke1: 'rgba(0,0,0,0.10)',
  colorNeutralStroke2: 'rgba(0,0,0,0.06)',
  colorNeutralForeground1: 'rgba(0,0,0,0.85)',
  colorNeutralForeground2: 'rgba(0,0,0,0.50)',
  colorNeutralForeground3: 'rgba(0,0,0,0.25)',
};

const winGeometry = {
  borderRadiusSmall: '4px',
  borderRadiusMedium: '4px',
  borderRadiusLarge: '8px',
  borderRadiusXLarge: '8px',
  fontFamilyBase:
    "'Segoe UI Variable Text', 'Segoe UI Variable Static Text', 'Segoe UI', system-ui, sans-serif",
  fontSizeBase300: '14px',
  lineHeightBase300: '20px',
};

const macGeometry = {
  borderRadiusSmall: '4px',
  borderRadiusMedium: '6px',
  borderRadiusLarge: '10px',
  borderRadiusXLarge: '12px',
  fontFamilyBase:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Helvetica Neue', sans-serif",
  // 13px body is the defining macOS metric.
  fontSizeBase300: '13px',
  lineHeightBase300: '16px',
};

/** macOS system blue, used when the accent can't be read. */
export const MAC_DEFAULT_ACCENT = '#007aff';
/** Windows system blue. */
export const WIN_DEFAULT_ACCENT = '#0078d4';

export function defaultAccentFor(platform: PlatformId): string {
  return platform === 'darwin' ? MAC_DEFAULT_ACCENT : WIN_DEFAULT_ACCENT;
}

/**
 * Build the Fluent theme for a given platform, accent and appearance.
 * `brandRampFromAccent` is shared — the ramp maths is platform-neutral.
 */
export function buildPlatformTheme(
  platform: PlatformId,
  accentHex: string,
  dark: boolean,
): Theme {
  const ramp: BrandVariants = brandRampFromAccent(
    accentHex || defaultAccentFor(platform),
  );
  const base = dark ? createDarkTheme(ramp) : createLightTheme(ramp);

  if (platform === 'darwin') {
    return { ...base, ...(dark ? macDark : macLight), ...macGeometry };
  }
  return { ...base, ...(dark ? winDark : winLight), ...winGeometry };
}

/**
 * Publish the platform and accent to CSS so platform.css and any hand-written
 * styles can branch on them. Call once at boot and again on appearanceChanged.
 */
export function applyPlatformToDom(
  platform: PlatformId,
  accentHex: string,
  dark: boolean,
): void {
  const root = document.documentElement;
  root.dataset.platform = platform;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--accent', accentHex || defaultAccentFor(platform));
  // Native form controls (checkboxes, range inputs, scrollbars) pick this up
  // for free and will match the rest of the UI.
  root.style.setProperty('accent-color', accentHex || defaultAccentFor(platform));
  root.style.colorScheme = dark ? 'dark' : 'light';
}
