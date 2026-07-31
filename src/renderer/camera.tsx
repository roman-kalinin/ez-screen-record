import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CameraOverlay, Rect } from '../shared/types';

/**
 * The on-screen camera bubble (Mode A).
 *
 * This window is a real, transparent, always-on-top surface on the recorded
 * display. ffmpeg's screen capture records whatever is painted here, so the
 * bubble ends up in the recording at full quality — no second webcam open, no
 * frame pipe. The webcam is opened ONCE, here, and the app's own preview keeps
 * showing the same device concurrently (same-process share), so the preview
 * stays live and editable during the take.
 *
 * The bubble is draggable/resizable in place; every change is echoed back to
 * the control window so the app preview and the on-screen bubble stay in sync.
 * The window is click-through everywhere except while the pointer is over the
 * bubble, so the rest of the desktop stays fully usable.
 */

declare global {
  interface Window {
    ez: import('../preload/preload').EzApi;
  }
}

/** Smallest the bubble may be, as a fraction of the frame — matches LayoutStage. */
const MIN_SIZE = 0.05;

type DragMode = { kind: 'move' | 'resize'; startX: number; startY: number; orig: Rect };

function CameraBubble() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dragRef = useRef<DragMode | null>(null);

  const [config, setConfig] = useState<CameraOverlay | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [hasFeed, setHasFeed] = useState(false);

  // Keep the latest rect available inside stable pointer handlers.
  const rectRef = useRef<Rect | null>(null);
  rectRef.current = rect;

  // --- Receive config from the control window --------------------------------
  useEffect(() => {
    const off = window.ez.on('cameraOverlay:config', (c: CameraOverlay) => {
      setConfig(c);
      // The control window is the source of truth for the rect until the user
      // drags here; adopt incoming rects only when not mid-drag.
      if (!dragRef.current) setRect(c.rect);
    });
    return () => off();
  }, []);

  // --- Own the camera (single capture) ---------------------------------------
  useEffect(() => {
    let cancelled = false;
    const deviceId = config?.deviceId;

    async function attach() {
      if (!deviceId) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setHasFeed(false);
        return;
      }
      // Already streaming this device — nothing to do.
      const current = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
      if (streamRef.current && current === deviceId) return;

      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setHasFeed(true);
      } catch {
        setHasFeed(false);
      }
    }

    attach();
    return () => {
      cancelled = true;
    };
  }, [config?.deviceId]);

  // Release the camera when the window goes away.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // --- Drag & resize (in place) ----------------------------------------------
  /**
   * The bubble node, so a drag can be painted straight to the DOM.
   *
   * This window lives ON the display being recorded, so work done here is work
   * taken from the recorder. Re-rendering React and posting IPC on every
   * pointer-move (at pointer rate, during a take) is exactly the contention
   * that starved ffmpeg. The gesture paints locally and publishes once on
   * release.
   */
  const bubbleRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<Rect | null>(null);

  const onPointerDown = (e: React.PointerEvent, kind: 'move' | 'resize') => {
    const orig = rectRef.current;
    if (!orig) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { kind, startX: e.clientX, startY: e.clientY, orig };
    latestRef.current = orig;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const wrap = wrapRef.current;
    if (!drag || !wrap) return;
    const b = wrap.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / b.width;
    const dy = (e.clientY - drag.startY) / b.height;

    let next: Rect;
    if (drag.kind === 'move') {
      const x = Math.min(Math.max(drag.orig.x + dx, 0), 1 - drag.orig.w);
      const y = Math.min(Math.max(drag.orig.y + dy, 0), 1 - drag.orig.h);
      next = { ...drag.orig, x, y };
    } else {
      const maxW = Math.max(1 - drag.orig.x, MIN_SIZE);
      const maxH = Math.max(1 - drag.orig.y, MIN_SIZE);
      const w = Math.max(MIN_SIZE, Math.min(drag.orig.w + dx, maxW));
      const h = Math.max(MIN_SIZE, Math.min(drag.orig.h + dy, maxH));
      next = { ...drag.orig, w, h };
    }

    latestRef.current = next;
    const node = bubbleRef.current;
    if (node) {
      node.style.left = `${next.x * 100}%`;
      node.style.top = `${next.y * 100}%`;
      node.style.width = `${next.w * 100}%`;
      node.style.height = `${next.h * 100}%`;
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    const final = latestRef.current;
    dragRef.current = null;
    latestRef.current = null;
    if (drag && final) {
      setRect(final);
      // Keep the app preview in lockstep with the on-screen bubble.
      window.ez.control.send('control:cameraRect', final);
    }
  };

  // The window is click-through by default; enable interaction only while the
  // pointer is actually over the bubble so the rest of the desktop stays live.
  const enterBubble = () => window.ez.cameraOverlay.setInteractive(true);
  const leaveBubble = () => {
    if (!dragRef.current) window.ez.cameraOverlay.setInteractive(false);
  };

  if (!config || !config.enabled || !config.deviceId || !rect) return null;

  const borderRadius =
    config.shape === 'circle' ? '50%' : config.shape === 'rounded' ? '12%' : '0';

  return (
    <div
      ref={wrapRef}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        ref={bubbleRef}
        style={{
          position: 'absolute',
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
          borderRadius,
          overflow: 'hidden',
          boxShadow: config.shadow ? '0 6px 20px rgba(0,0,0,0.5)' : 'none',
          visibility: hasFeed ? 'visible' : 'hidden',
          cursor: 'move',
          // This element is the only interactive surface in the window.
          pointerEvents: 'auto',
        }}
        onPointerEnter={enterBubble}
        onPointerLeave={leaveBubble}
        onPointerDown={(e) => onPointerDown(e, 'move')}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            transform: config.mirrored ? 'scaleX(-1)' : undefined,
          }}
        />
        {/* Resize handle, bottom-right. */}
        <div
          onPointerDown={(e) => onPointerDown(e, 'resize')}
          style={{
            position: 'absolute',
            right: '-2px',
            bottom: '-2px',
            width: '16px',
            height: '16px',
            borderRadius: '4px',
            background: '#0a84ff',
            border: '2px solid #fff',
            cursor: 'nwse-resize',
            pointerEvents: 'auto',
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<CameraBubble />);
