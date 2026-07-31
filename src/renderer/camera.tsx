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

type Corner = 'nw' | 'ne' | 'sw' | 'se';

type DragMode = { kind: 'move' | 'resize'; corner: Corner; startX: number; startY: number; orig: Rect };

/**
 * Resize by dragging one corner; the opposite corner stays pinned.
 *
 * Mirrors LayoutStage.resizeRect. Kept as its own copy rather than imported:
 * this file is a separate Vite entry point that ships to the on-screen overlay
 * window, and pulling in the stage would drag Fluent's whole component tree
 * onto the display being recorded.
 */
function resizeRect(orig: Rect, corner: Corner, dx: number, dy: number): Rect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;

  let { x, y, w, h } = orig;

  if (west) {
    x = Math.min(Math.max(orig.x + dx, 0), right - MIN_SIZE);
    w = right - x;
  } else {
    w = Math.max(MIN_SIZE, Math.min(orig.w + dx, 1 - orig.x));
  }

  if (north) {
    y = Math.min(Math.max(orig.y + dy, 0), bottom - MIN_SIZE);
    h = bottom - y;
  } else {
    h = Math.max(MIN_SIZE, Math.min(orig.h + dy, 1 - orig.y));
  }

  return { ...orig, x, y, w, h };
}

/** Anchor placement, matching the preview stage. */
const CORNERS: Array<{ id: Corner; css: React.CSSProperties }> = [
  { id: 'nw', css: { left: -9, top: -9, cursor: 'nwse-resize' } },
  { id: 'ne', css: { right: -9, top: -9, cursor: 'nesw-resize' } },
  { id: 'sw', css: { left: -9, bottom: -9, cursor: 'nesw-resize' } },
  { id: 'se', css: { right: -9, bottom: -9, cursor: 'nwse-resize' } },
];

function CameraBubble() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dragRef = useRef<DragMode | null>(null);

  const [config, setConfig] = useState<CameraOverlay | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [hasFeed, setHasFeed] = useState(false);
  /**
   * Show the resize frame. On when the pointer is over the bubble, and pinned
   * on for the whole of a drag — a resize starts at a corner and immediately
   * leaves it, so a pure :hover frame would vanish the moment it was grabbed.
   */
  const [showFrame, setShowFrame] = useState(false);

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

      // Only skip when the held stream is genuinely LIVE on this device.
      // Checking the device id alone was not enough: after a failed switch the
      // ref still pointed at stopped tracks, so switching back to a working
      // camera matched here and returned early, and the bubble stayed dead for
      // the rest of the session.
      const track = streamRef.current?.getVideoTracks()[0];
      if (track && track.readyState === 'live' && track.getSettings().deviceId === deviceId) {
        return;
      }

      // Release the old device BEFORE asking for the new one, and clear the ref
      // with it — a stale ref is what made the failure permanent. Some webcams
      // also refuse a second open while the first is still held.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setHasFeed(false);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        // A newer switch may have started while this was in flight; that one
        // owns the device now.
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        if (!cancelled) setHasFeed(true);
      } catch {
        // Leave the ref null so the next attempt actually retries instead of
        // matching against a dead stream.
        streamRef.current = null;
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
  const frameRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<Rect | null>(null);

  const onPointerDown = (
    e: React.PointerEvent,
    kind: 'move' | 'resize',
    corner: Corner = 'se',
  ) => {
    const orig = rectRef.current;
    if (!orig) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { kind, corner, startX: e.clientX, startY: e.clientY, orig };
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
      next = resizeRect(drag.orig, drag.corner, dx, dy);
    }

    latestRef.current = next;
    // Media box and its selection frame are siblings (the frame must sit
    // outside the clip so a circular bubble cannot swallow the anchors), so
    // both are painted here rather than one riding along with the other.
    for (const node of [bubbleRef.current, frameRef.current]) {
      if (!node) continue;
      node.style.left = `${next.x * 100}%`;
      node.style.top = `${next.y * 100}%`;
      node.style.width = `${next.w * 100}%`;
      node.style.height = `${next.h * 100}%`;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const final = latestRef.current;
    dragRef.current = null;
    latestRef.current = null;
    if (drag && final) {
      setRect(final);
      // Keep the app preview in lockstep with the on-screen bubble.
      window.ez.control.send('control:cameraRect', final);
    }
    // leaveBubble() bailed out for the whole gesture to protect pointer
    // capture, so the hover state is settled here instead. If the pointer
    // ended up off the bubble, hand the desktop back.
    if (drag) {
      const over = (e.target as HTMLElement | null)?.closest('[data-cam-hit]');
      if (!over) {
        setShowFrame(false);
        window.ez.cameraOverlay.setInteractive(false);
      }
    }
  };

  // The window is click-through by default; enable interaction only while the
  // pointer is actually over the bubble so the rest of the desktop stays live.
  const enterBubble = () => {
    setShowFrame(true);
    window.ez.cameraOverlay.setInteractive(true);
  };
  const leaveBubble = () => {
    // A drag holds pointer capture and routinely travels outside the element it
    // started on; releasing interactivity there would drop the gesture.
    if (dragRef.current) return;
    setShowFrame(false);
    window.ez.cameraOverlay.setInteractive(false);
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
        data-cam-hit=""
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
      </div>

      {/* Selection frame + anchors, drawn as a SIBLING of the media box.
          Inside it they were clipped away by the shape mask — invisible on a
          circle, half-eaten on a rounded rect. Always rectangular so the drag
          bounds read clearly around a round bubble. It appears on hover (and
          stays for the duration of a drag) so it is out of the way otherwise.
          `showFrame` never blocks recording: this window is excluded from
          capture, and the bubble beneath is what the recorder actually sees. */}
      {hasFeed && (
        <div
          ref={frameRef}
          style={{
            position: 'absolute',
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
            outline: showFrame ? '1.5px solid #0a84ff' : 'none',
            // Anchors are the only hit targets; the frame itself must let
            // pointer events through to the media box for move-drags.
            pointerEvents: 'none',
            opacity: showFrame ? 1 : 0,
            transition: 'opacity 120ms ease',
          }}
        >
          {CORNERS.map((c) => (
            <div
              key={c.id}
              data-cam-hit=""
              onPointerEnter={enterBubble}
              onPointerLeave={leaveBubble}
              onPointerDown={(e) => onPointerDown(e, 'resize', c.id)}
              style={{
                position: 'absolute',
                width: 18,
                height: 18,
                display: 'grid',
                placeItems: 'center',
                pointerEvents: showFrame ? 'auto' : 'none',
                ...c.css,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: '#fff',
                  border: '2px solid #0a84ff',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.45)',
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<CameraBubble />);
