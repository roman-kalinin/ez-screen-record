# Feature parity: Electron → WinUI

Audit of `src/` against `winui/`, and the plan to close the gap.

## The structural mistake

The WinUI port was built as a **settings form**: a column of cards (Source,
Layout, Recording options, Output) with a Start button at the bottom.

The Electron app is not that. It is a **Google-Meet-style control bar**:

```
┌──────────────────────────────────────────────┐
│ ● Ez Screen Record            📌  ─  ✕       │  title bar, pulsing dot while recording
├──────────────────────────────────────────────┤
│                                              │
│          [ live 16:9 preview stage ]         │  real screen + real webcam feed
│                                              │
│          [ image overlay list ]              │  only when images exist
├──────────────────────────────────────────────┤
│ 🎤▾ 📷▾ 🖥 🖼 ✏ ⚙ ?        00:42  ⏸ ⏺       │  the control bar
└──────────────────────────────────────────────┘
```

Everything the port put in cards lives in the **settings flyout** behind the
gear. Quality, resolution, frame rate, countdown, hide-toolbar and output
folder are all there — none of them are cards on the main surface.

So this is not a matter of patching the current layout. The main window has to
be rebuilt around the control bar.

## Gap list

### A. Main window — rebuild required

| # | Feature | Status |
| --- | --- | --- |
| A1 | Meet-style control bar (mic pill, camera pill, source, add-image, draw, settings, shortcuts, spacer, timer, transport) | **missing** |
| A2 | Live screen preview in the stage (throttled 15fps/1280px) | **missing** (static thumbnail) |
| A3 | Live webcam preview in the stage | **missing** (grey "Camera" box) |
| A4 | Settings flyout (quality, resolution, fps, countdown, hide-toolbar, output dir) | wrong place (cards) |
| A5 | Keyboard-shortcuts flyout | **missing** |
| A6 | Title bar: pulsing rec dot, pin-on-top, minimize, close | **missing** |
| A7 | Close-while-recording confirmation | **missing** |
| A8 | Countdown overlay (120px number, cancellable) | **missing** |
| A9 | Toasts with Dismiss + "Show in folder" link | **missing** (InfoBar only) |
| A10 | Image overlays: add, list, thumbnail, visible switch, remove | **missing** |
| A11 | Floating camera shape bar on the preview (rounded/square/circle/mirror/shadow) | partly (in Layout header) |
| A12 | Four corner anchors on camera, single SE handle on images | camera only |

### B. Source picker

| # | Feature | Status |
| --- | --- | --- |
| B1 | Duplicate entries (every source listed twice) | **BUG** |
| B2 | "Clear selection" action | **missing** |
| B3 | Auto-select the tab matching the current source | **missing** |
| B4 | Minimized-window hint text | **missing** |
| B5 | Click a card = select and close immediately | **missing** (needs Select button) |
| B6 | Filter out the app's own windows | **missing** |

### C. Recording toolbar

| # | Feature | Status |
| --- | --- | --- |
| C1 | Full-screen transparent click-through host window | **wrong** (small window) |
| C2 | Dark pill, 32px radius, top-centre, drag grip, clamped on-screen | **missing** |
| C3 | Mic + camera PillControls with device menus | **missing** |
| C4 | Source button (reopens main window) | **missing** |
| C5 | Timer, pause, 58x40 red stop | partly |
| C6 | Does not appear at all while recording | **BUG** |

### D. Drawing overlay

| # | Feature | Status |
| --- | --- | --- |
| D1 | Compact palette: 32x32 tools, 22x22 swatches, 84px slider, 12px radius | **missing** (no palette) |
| D2 | Six colours (#ff3b30 #ffcc00 #34c759 #0a84ff #ffffff #000000) | **missing** |
| D3 | Thickness slider 2–24 | **missing** |
| D4 | Draggable palette, default (24,24) | **missing** |
| D5 | Clear-all and Done buttons | **missing** |
| D6 | Tool keys P/H/A/R/O/E, Ctrl+Z, Del, Esc | **missing** |
| D7 | Eraser: stroke-level, 18px radius | radius wrong |

### E. Shell integration

| # | Feature | Status |
| --- | --- | --- |
| E1 | Reveal saved file in Explorer | **missing** |
| E2 | Open output folder | **missing** |

### F. Devices

| # | Feature | Status |
| --- | --- | --- |
| F1 | Device de-duplication (Default -/Communications - prefixes, trailing hw id) | **missing** |
| F2 | Hot-plug re-enumeration | **missing** |
| F3 | Mid-take device/source switching | **missing** |

## Order of work

1. **B1** — duplicate sources (breaks the picker outright)
2. **A1/A4/A5/A6** — rebuild the main window as the control bar
3. **A2/A3** — live previews, which is what makes the stage worth having
4. **C** — the recording toolbar
5. **D** — the drawing palette
6. **E** — reveal/open folder
7. **A10, B2–B6, F** — the remainder
8. Verify a real recording end to end, through the UI, with a screenshot

## Rule

Nothing here is closed until it has been exercised in the running app and seen
on screen. "It builds" and "it launched" are not evidence.
