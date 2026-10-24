import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  CaptureSource,
  EditorExportRequest,
  EditorExportResult,
  EditorSession,
  SaveResult,
} from '../shared/types';

/** The single, explicit surface the renderers are allowed to touch.
 *  Node integration stays off; everything crosses through here. */
const api = {
  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('sources:list'),
  /** Un-minimize a window so it can be captured. */
  restoreWindow: (sourceId: string): Promise<boolean> =>
    ipcRenderer.invoke('sources:restoreWindow', sourceId),

  /** macOS capture-permission helpers. 'granted' on Windows. */
  permissions: {
    /** 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'. */
    screenStatus: (): Promise<string> => ipcRenderer.invoke('permissions:screenStatus'),
    /** Open the Screen Recording pane of System Settings (macOS). */
    openScreenSettings: (): Promise<boolean> =>
      ipcRenderer.invoke('permissions:openScreenSettings'),
  },

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: AppSettings): Promise<boolean> => ipcRenderer.invoke('settings:set', s),
  /** Report the recorder state so the macOS menu-bar menu stays accurate. */
  setRecordingState: (state: string): Promise<boolean> =>
    ipcRenderer.invoke('app:recordingState', state),

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
    /**
     * @param keepAlive Park the control window off-screen instead of hiding
     *   it. Required by the browser engine, whose canvas compositor stops
     *   rendering the moment the window is hidden.
     */
    setToolbarMode: (on: boolean, keepAlive = false) =>
      ipcRenderer.invoke('win:setToolbarMode', on, keepAlive),
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
    /** Can a native take be paused and still save as one file? */
    canPause: (): Promise<boolean> => ipcRenderer.invoke('native:canPause'),
    audioDevices: (): Promise<string[]> => ipcRenderer.invoke('native:audioDevices'),
    devices: (): Promise<{ audio: string[]; video: string[] }> =>
      ipcRenderer.invoke('native:devices'),
    start: (opts: {
      fps: number;
      height?: number;
      quality: 'high' | 'balanced' | 'compact';
      micDeviceName?: string | null;
      systemAudioEnabled?: boolean;
      camera?: {
        deviceName: string;
        rect: { x: number; y: number; w: number; h: number };
        cornerRounding: number;
        mirrored: boolean;
      } | null;
      outputDir: string | null;
      /** Electron display id of the chosen screen, so ddagrab captures it. */
      displayId?: string;
    }): Promise<SaveResult> => ipcRenderer.invoke('native:start', opts),
    stop: (): Promise<SaveResult> => ipcRenderer.invoke('native:stop'),
    /** Swap monitor/microphone mid-take; splits the take at the change. */
    reconfigure: (patch: {
      micDeviceName?: string | null;
      displayId?: string;
    }): Promise<{ ok: boolean; error?: string; paused?: boolean }> =>
      ipcRenderer.invoke('native:reconfigure', patch),
    /** Hold the ffmpeg take. Resolves with the state that actually resulted. */
    pause: (): Promise<{ ok: boolean; paused: boolean; error?: string }> =>
      ipcRenderer.invoke('native:pause'),
    resume: (): Promise<{ ok: boolean; paused: boolean; error?: string }> =>
      ipcRenderer.invoke('native:resume'),
  },

  /**
   * Do Not Disturb while recording. enable() is called by the renderer at the
   * real start of a take (guarded by the setting); disable() at stop. Both are
   * best-effort in the main process and never block recording.
   */
  dnd: {
    enable: (): Promise<boolean> => ipcRenderer.invoke('dnd:enable'),
    disable: (): Promise<boolean> => ipcRenderer.invoke('dnd:disable'),
  },

  /** Upload a finished recording to GoFile and get a shareable link.
   *  Progress arrives on the 'share:uploadProgress' channel via on(). */
  share: {
    upload: (
      filePath: string,
    ): Promise<{ ok: boolean; viewUrl?: string; error?: string }> =>
      ipcRenderer.invoke('share:upload', filePath),
  },

  /**
   * The built-in single-video editor. open() is called from the control
   * window; everything else is called from inside an editor window, which the
   * main process identifies by its webContents — each editor edits exactly the
   * one file it was opened on. Export progress arrives on
   * 'editor:exportProgress' via on().
   */
  editor: {
    open: (filePath: string): Promise<boolean> => ipcRenderer.invoke('editor:open', filePath),
    session: (): Promise<EditorSession | null> => ipcRenderer.invoke('editor:session'),
    chooseOutput: (current: string): Promise<{ path?: string; error?: string } | null> =>
      ipcRenderer.invoke('editor:chooseOutput', current),
    export: (req: EditorExportRequest): Promise<EditorExportResult> =>
      ipcRenderer.invoke('editor:export', req),
    cancelExport: (): Promise<boolean> => ipcRenderer.invoke('editor:cancelExport'),
    window: (action: 'minimize' | 'maximize' | 'close'): Promise<void> =>
      ipcRenderer.invoke('editor:window', action),
  },

  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseOutputDir'),
  defaultOutputDir: (): Promise<string> => ipcRenderer.invoke('paths:defaultOutputDir'),
  /** Version of the running build, e.g. "1.1.0". */
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** System accent colour and light/dark preference. */
  appearance: (): Promise<{ accent: string; dark: boolean; platform: string }> =>
    ipcRenderer.invoke('system:appearance'),
  revealFile: (p: string) => ipcRenderer.invoke('shell:revealFile', p),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  /** Open the recordings output folder in the OS file manager. */
  openOutputFolder: (): Promise<string> => ipcRenderer.invoke('shell:openOutputDir'),

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
