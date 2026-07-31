import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, CaptureSource, SaveResult } from '../shared/types';

/** The single, explicit surface the renderers are allowed to touch.
 *  Node integration stays off; everything crosses through here. */
const api = {
  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('sources:list'),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: AppSettings): Promise<boolean> => ipcRenderer.invoke('settings:set', s),

  overlay: {
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    setInteractive: (v: boolean) => ipcRenderer.invoke('overlay:setInteractive', v),
    focus: () => ipcRenderer.invoke('overlay:focus'),
    send: (channel: string, payload?: unknown) =>
      ipcRenderer.invoke('overlay:send', channel, payload),
  },

  control: {
    send: (channel: string, payload?: unknown) =>
      ipcRenderer.invoke('control:send', channel, payload),
  },

  /** The Zoom-style control strip shown while recording. */
  toolbar: {
    setInteractive: (v: boolean) => ipcRenderer.invoke('toolbar:setInteractive', v),
    send: (channel: string, payload?: unknown) =>
      ipcRenderer.invoke('toolbar:send', channel, payload),
  },

  /** The on-screen camera bubble shown while recording. */
  cameraOverlay: {
    show: (displayId?: string) => ipcRenderer.invoke('cameraOverlay:show', displayId),
    hide: () => ipcRenderer.invoke('cameraOverlay:hide'),
    setInteractive: (v: boolean) => ipcRenderer.invoke('cameraOverlay:setInteractive', v),
    send: (channel: string, payload?: unknown) =>
      ipcRenderer.invoke('cameraOverlay:send', channel, payload),
  },

  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    close: (isRecording = false) => ipcRenderer.invoke('win:close', isRecording),
    setAlwaysOnTop: (flag: boolean) => ipcRenderer.invoke('win:setAlwaysOnTop', flag),
    /** Collapse the window into the compact recording toolbar, or restore it. */
    setToolbarMode: (on: boolean) => ipcRenderer.invoke('win:setToolbarMode', on),
    /** Hide the recording toolbar from screen capture. */
    setHideFromCapture: (hide: boolean) =>
      ipcRenderer.invoke('win:setHideFromCapture', hide),
    /** Exclude the control panel from screen capture while recording. */
    setCaptureHidden: (hidden: boolean) => ipcRenderer.invoke('win:setCaptureHidden', hidden),
  },

  saveRecording: (
    buffer: ArrayBuffer,
    name: string,
    outputDir: string | null,
  ): Promise<SaveResult> => ipcRenderer.invoke('recording:save', buffer, name, outputDir),

  /** ffmpeg-backed capture: far higher quality, but cannot composite overlays. */
  native: {
    available: (): Promise<boolean> => ipcRenderer.invoke('native:available'),
    audioDevices: (): Promise<string[]> => ipcRenderer.invoke('native:audioDevices'),
    devices: (): Promise<{ audio: string[]; video: string[] }> =>
      ipcRenderer.invoke('native:devices'),
    start: (opts: {
      fps: number;
      height?: number;
      quality: 'high' | 'balanced' | 'compact';
      micDeviceName?: string | null;
      camera?: {
        deviceName: string;
        rect: { x: number; y: number; w: number; h: number };
        cornerRounding: number;
        mirrored: boolean;
      } | null;
      outputDir: string | null;
    }): Promise<SaveResult> => ipcRenderer.invoke('native:start', opts),
    stop: (): Promise<SaveResult> => ipcRenderer.invoke('native:stop'),
  },

  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseOutputDir'),
  defaultOutputDir: (): Promise<string> => ipcRenderer.invoke('paths:defaultOutputDir'),
  /** System accent colour and light/dark preference. */
  appearance: (): Promise<{ accent: string; dark: boolean }> =>
    ipcRenderer.invoke('system:appearance'),
  revealFile: (p: string) => ipcRenderer.invoke('shell:revealFile', p),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),

  /** Subscribe to a main->renderer channel. Returns an unsubscribe function.
   *  The braces matter: removeListener is chainable, and returning its value
   *  would make this incompatible with React's effect-cleanup signature. */
  on: (channel: string, cb: (payload: any) => void): (() => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('ez', api);

export type EzApi = typeof api;
