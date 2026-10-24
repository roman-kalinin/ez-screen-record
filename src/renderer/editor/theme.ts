import type { Theme } from '@fluentui/react-components';
import { buildTheme } from '../theme';

/**
 * The editor's look: the app's own Fluent theme (system accent, Segoe UI
 * Variable, same components) with warmer, darker surfaces.
 *
 * The control window is a small WinUI panel; the editor is a full workspace
 * someone stares at while scrubbing, so it uses a quieter near-black with a
 * slight warm cast and lower-contrast hairlines. The accent is kept for the
 * few things that should draw the eye: Export, the playhead progress and focus.
 * Always dark — video is judged against a dark surround.
 */
export const ed = {
  page: '#131211',
  surface: '#1a1917',
  surfaceRaised: '#211f1d',
  well: '#0b0a09',
  hairline: 'rgba(255, 244, 230, 0.07)',
  hairlineStrong: 'rgba(255, 244, 230, 0.12)',
  ink1: '#ecebe7',
  ink2: 'rgba(236, 233, 226, 0.70)',
  ink3: 'rgba(236, 233, 226, 0.46)',
  ink4: 'rgba(236, 233, 226, 0.28)',
  fillSoft: 'rgba(255, 244, 230, 0.05)',
  fillMed: 'rgba(255, 244, 230, 0.08)',
  // Cut regions: a muted coral, destructive without shouting.
  cut: 'rgba(226, 104, 78, 0.30)',
  cutHover: 'rgba(226, 104, 78, 0.40)',
  cutEdge: '#e2785f',
  pending: '#e6b450',
  mono: "'Cascadia Mono', 'Cascadia Code', Consolas, ui-monospace, monospace",
};

export function buildEditorTheme(accent: string): Theme {
  const base = buildTheme(accent, true);
  return {
    ...base,
    colorNeutralBackground1: ed.surface,
    colorNeutralBackground1Hover: ed.surfaceRaised,
    colorNeutralBackground1Pressed: '#171614',
    colorNeutralBackground1Selected: ed.surfaceRaised,
    colorNeutralBackground2: '#171614',
    colorNeutralBackground3: ed.page,
    colorNeutralBackground4: '#1f1d1b',
    colorNeutralBackground4Hover: '#252321',
    colorNeutralBackgroundStatic: '#1f1d1b',
    colorNeutralBackground6: '#1f1d1b',
    colorNeutralBackgroundAlpha: '#1f1d1b',
    colorNeutralBackgroundAlpha2: '#1f1d1b',
    colorNeutralStroke1: ed.hairlineStrong,
    colorNeutralStroke1Hover: 'rgba(255, 244, 230, 0.18)',
    colorNeutralStroke1Pressed: 'rgba(255, 244, 230, 0.14)',
    colorNeutralStroke2: ed.hairline,
    colorNeutralStroke3: ed.hairline,
    colorNeutralStrokeAccessible: 'rgba(255, 244, 230, 0.36)',
    colorNeutralForeground1: ed.ink1,
    colorNeutralForeground1Hover: '#ffffff',
    colorNeutralForeground2: ed.ink2,
    colorNeutralForeground2Hover: ed.ink1,
    colorNeutralForeground3: ed.ink3,
    colorNeutralForeground4: ed.ink4,
    colorNeutralForegroundDisabled: ed.ink4,
    colorSubtleBackground: 'transparent',
    colorSubtleBackgroundHover: ed.fillSoft,
    colorSubtleBackgroundPressed: 'rgba(255, 244, 230, 0.035)',
    colorSubtleBackgroundSelected: ed.fillMed,
    borderRadiusSmall: '4px',
    borderRadiusMedium: '6px',
    borderRadiusLarge: '10px',
    borderRadiusXLarge: '14px',
  };
}
