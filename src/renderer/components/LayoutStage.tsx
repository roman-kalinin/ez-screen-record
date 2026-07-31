import React, { useCallback, useEffect, useRef, useState } from 'react';
import { makeStyles, tokens, Text, Button, Tooltip } from '@fluentui/react-components';
import {
  SquareRegular,
  CircleRegular,
  RectangleLandscapeRegular,
  FlipHorizontalRegular,
} from '@fluentui/react-icons';
import type { CameraOverlay, ImageOverlay, OverlayShape, Rect } from '../../shared/types';

/**
 * A live 16:9 preview of the final frame. Everything here is expressed in
 * normalised (0..1) coordinates so a layout arranged against a 1080p preview
 * still lands correctly on a 1440p capture.
 */

const useStyles = makeStyles({
  wrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    // Keep the whole preview on screen in a short window. The aspect ratio is
    // preserved (it defines the drag coordinate space), so the width follows
    // the height down rather than the stage being squashed.
    maxHeight: '100%',
    margin: '0 auto',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    background: '#000',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    userSelect: 'none',
  },
  screenVideo: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    // `cover` rather than `contain`: overlay rects are normalised against the
    // full frame, so the preview must fill the stage edge-to-edge or the
    // positions shown here would not match the recorded output.
    objectFit: 'cover',
    background: '#000',
  },
  empty: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
    padding: '16px',
  },
  item: {
    position: 'absolute',
    cursor: 'move',
    touchAction: 'none',
  },
  camVideo: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  selected: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    outlineOffset: '1px',
  },
  handle: {
    position: 'absolute',
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    background: tokens.colorBrandBackground,
    border: '2px solid #fff',
    right: '-7px',
    bottom: '-7px',
    cursor: 'nwse-resize',
  },
  hint: {
    position: 'absolute',
    left: '8px',
    bottom: '8px',
    padding: '3px 8px',
    borderRadius: tokens.borderRadiusSmall,
    background: 'rgba(0,0,0,0.65)',
    pointerEvents: 'none',
  },
  // Floating shape picker, shown above the camera when it is selected.
  shapeBar: {
    position: 'absolute',
    display: 'flex',
    gap: '2px',
    padding: '3px',
    borderRadius: tokens.borderRadiusMedium,
    background: 'rgba(28,28,32,0.94)',
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    zIndex: 5,
  },
  shapeBtn: {
    width: '26px',
    height: '26px',
    minWidth: '26px',
    padding: 0,
  },
});

type DragMode = { kind: 'move' | 'resize'; id: string; startX: number; startY: number; orig: Rect };

interface Props {
  screenSourceId: string | null;
  camera: CameraOverlay;
  images: ImageOverlay[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCameraRect: (r: Rect) => void;
  onImageRect: (id: string, r: Rect) => void;
  onCameraShape: (s: OverlayShape) => void;
  onCameraMirror: (m: boolean) => void;
  /**
   * Release the webcam and screen capture.
   *
   * DirectShow grants exclusive access to a capture device, so while ffmpeg
   * owns the camera this preview must not also hold it — otherwise the app
   * blocks its own recording. Set while a native take is running.
   */
  suspendCapture?: boolean;
}

/** Smallest an overlay may be shrunk to, as a fraction of the frame. */
const MIN_SIZE = 0.05;

const SHAPES: Array<{ id: OverlayShape; label: string; icon: JSX.Element }> = [
  { id: 'rounded', label: 'Rounded', icon: <RectangleLandscapeRegular /> },
  { id: 'square', label: 'Square', icon: <SquareRegular /> },
  { id: 'circle', label: 'Circle', icon: <CircleRegular /> },
];

export function LayoutStage({
  screenSourceId,
  camera,
  images,
  selectedId,
  onSelect,
  onCameraRect,
  onImageRect,
  onCameraShape,
  onCameraMirror,
  suspendCapture = false,
}: Props) {
  const s = useStyles();
  const wrapRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<DragMode | null>(null);
  const [screenErr, setScreenErr] = useState<string | null>(null);
  /** True once the camera stream is actually live and painting frames. */
  const [hasCameraFeed, setHasCameraFeed] = useState(false);
  /**
   * A gesture is in progress. Only used to hide the floating shape bar: the
   * dragged element is painted directly to the DOM, so anything positioned
   * from React state would trail a frame behind it until the pointer is
   * released. One state flip per gesture, not per pointer-move.
   */
  const [dragging, setDragging] = useState(false);

  // --- Live screen preview ---------------------------------------------------
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function attach() {
      setScreenErr(null);
      // Stop duplicating the screen capture while ffmpeg is recording it —
      // there is no need to pay for two captures of the same display.
      if (suspendCapture || !screenSourceId) {
        if (screenRef.current) screenRef.current.srcObject = null;
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // Electron-specific `mandatory` constraints (see recorder.ts).
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSourceId,
              // A low preview framerate keeps the UI cheap while idle. During
              // a take this component is unmounted outright (see App.tsx), so
              // there is no throttled mode to reason about.
              maxFrameRate: 15,
              maxWidth: 1280,
            },
          },
        } as unknown as MediaStreamConstraints);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (screenRef.current) {
          screenRef.current.srcObject = stream;
          await screenRef.current.play().catch(() => {});
        }
      } catch (err) {
        if (!cancelled) setScreenErr((err as Error).message);
      }
    }

    attach();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [screenSourceId, suspendCapture]);

  // --- Live camera preview ---------------------------------------------------
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function attach() {
      // Hand the device to ffmpeg while a native recording is running.
      if (suspendCapture || !camera.enabled || !camera.deviceId) {
        if (camRef.current) camRef.current.srcObject = null;
        setHasCameraFeed(false);
        return;
      }
      // Detach the previous stream before opening the next device. Cleanup
      // stops the old tracks, but it runs after this effect has already asked
      // for the new ones, so without this both are briefly open — and some
      // webcams refuse the second open while the first is still held.
      if (camRef.current?.srcObject) {
        (camRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        camRef.current.srcObject = null;
      }
      setHasCameraFeed(false);

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: camera.deviceId }, width: { ideal: 640 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // The <video> is always mounted (only its container is hidden), so the
        // ref is reliably present here. Marking the feed live is what reveals
        // the overlay.
        if (camRef.current) {
          camRef.current.srcObject = stream;
          await camRef.current.play().catch(() => {});
        }
        if (!cancelled) setHasCameraFeed(true);
      } catch {
        // Preview is best-effort; recording reports its own errors. Keep the
        // frame hidden so the user isn't shown a box that will never fill.
        setHasCameraFeed(false);
      }
    }

    attach();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camera.enabled, camera.deviceId, suspendCapture]);

  // --- Drag & resize ---------------------------------------------------------
  const rectFor = (id: string): Rect | null => {
    if (id === 'camera') return camera.rect;
    return images.find((i) => i.id === id)?.rect ?? null;
  };

  const commit = (id: string, r: Rect) => {
    if (id === 'camera') onCameraRect(r);
    else onImageRect(id, r);
  };

  /**
   * Geometry for the element currently being dragged.
   *
   * A drag fires a pointer-move per frame, and routing each one through React
   * state re-rendered the whole stage — every overlay, the shape bar and the
   * <video> wrappers — at pointer rate. That is pure CPU the recorder needs, so
   * during a gesture the position is written straight to the node's style and
   * React is left untouched until the pointer is released.
   */
  const dragNodeRef = useRef<HTMLElement | null>(null);
  const latestRectRef = useRef<Rect | null>(null);

  const paint = (node: HTMLElement, r: Rect) => {
    node.style.left = `${r.x * 100}%`;
    node.style.top = `${r.y * 100}%`;
    node.style.width = `${r.w * 100}%`;
    node.style.height = `${r.h * 100}%`;
  };

  const onPointerDown = (e: React.PointerEvent, id: string, kind: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    const orig = rectFor(id);
    if (!orig) return;
    onSelect(id);
    dragRef.current = { kind, id, startX: e.clientX, startY: e.clientY, orig };
    latestRectRef.current = orig;
    // The resize handle is a child of the overlay box; the box itself is what
    // must move, so walk up to the positioned ancestor.
    const target = e.currentTarget as HTMLElement;
    dragNodeRef.current = kind === 'resize' ? target.parentElement : target;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    const wrap = wrapRef.current;
    if (!drag || !wrap) return;

    const bounds = wrap.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / bounds.width;
    const dy = (e.clientY - drag.startY) / bounds.height;

    let next: Rect;
    if (drag.kind === 'move') {
      // Clamp so an overlay can never be dragged fully off-frame.
      const x = Math.min(Math.max(drag.orig.x + dx, 0), 1 - drag.orig.w);
      const y = Math.min(Math.max(drag.orig.y + dy, 0), 1 - drag.orig.h);
      next = { ...drag.orig, x, y };
    } else {
      // Clamp to the available space FIRST, then apply the minimum — doing it
      // the other way round lets the min defeat the max near an edge and the
      // overlay collapses below its intended minimum size.
      const maxW = Math.max(1 - drag.orig.x, MIN_SIZE);
      const maxH = Math.max(1 - drag.orig.y, MIN_SIZE);
      const w = Math.max(MIN_SIZE, Math.min(drag.orig.w + dx, maxW));
      const h = Math.max(MIN_SIZE, Math.min(drag.orig.h + dy, maxH));
      next = { ...drag.orig, w, h };
    }

    latestRectRef.current = next;
    if (dragNodeRef.current) paint(dragNodeRef.current, next);
  }, []);

  const onPointerUp = () => {
    const drag = dragRef.current;
    const finalRect = latestRectRef.current;
    dragRef.current = null;
    dragNodeRef.current = null;
    latestRectRef.current = null;
    if (drag) setDragging(false);
    // Publish once, at the end of the gesture. React then re-renders with the
    // same geometry already painted, so there is no visible snap.
    if (drag && finalRect) commit(drag.id, finalRect);
  };

  const borderRadius =
    camera.shape === 'circle' ? '50%' : camera.shape === 'rounded' ? '12%' : '0';

  return (
    <div
      ref={wrapRef}
      className={s.wrap}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // No onPointerLeave: the dragged element holds pointer capture, so
      // moving past the stage edge would otherwise abort the drag mid-gesture.
      onPointerCancel={onPointerUp}
      onPointerDown={() => onSelect(null)}
    >
      <video ref={screenRef} className={s.screenVideo} muted playsInline />

      {suspendCapture && (
        <div className={s.empty}>
          <Text size={200}>
            Recording — the camera is held by the recorder. Turn on “Show camera on screen
            while recording” to keep it live here.
          </Text>
        </div>
      )}

      {!suspendCapture && !screenSourceId && (
        <div className={s.empty}>
          <Text size={200}>Pick a screen or window below to see a live preview</Text>
        </div>
      )}
      {screenErr && (
        <div className={s.empty}>
          <Text size={200}>Preview unavailable: {screenErr}</Text>
        </div>
      )}

      {/* Images render beneath the camera, matching the recorder's z-order. */}
      {images
        .filter((i) => i.visible)
        .map((img) => (
          <div
            key={img.id}
            className={`${s.item} ${selectedId === img.id ? s.selected : ''}`}
            style={{
              left: `${img.rect.x * 100}%`,
              top: `${img.rect.y * 100}%`,
              width: `${img.rect.w * 100}%`,
              height: `${img.rect.h * 100}%`,
              opacity: img.opacity,
            }}
            onPointerDown={(e) => onPointerDown(e, img.id, 'move')}
          >
            <img
              src={img.src}
              alt={img.name}
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
            {selectedId === img.id && (
              <div
                className={s.handle}
                onPointerDown={(e) => onPointerDown(e, img.id, 'resize')}
              />
            )}
          </div>
        ))}

      {/* The <video> stays mounted whenever a camera is selected, so its ref
          exists for the stream to attach to. Visibility is driven by
          hasCameraFeed — gating the element itself would deadlock, since the
          ref would never exist for the feed to start. */}
      {camera.enabled && camera.deviceId && (
        <div
          className={`${s.item} ${selectedId === 'camera' ? s.selected : ''}`}
          style={{
            left: `${camera.rect.x * 100}%`,
            top: `${camera.rect.y * 100}%`,
            width: `${camera.rect.w * 100}%`,
            height: `${camera.rect.h * 100}%`,
            borderRadius,
            overflow: 'hidden',
            boxShadow: camera.shadow ? '0 6px 20px rgba(0,0,0,0.5)' : 'none',
            visibility: hasCameraFeed ? 'visible' : 'hidden',
          }}
          onPointerDown={(e) => onPointerDown(e, 'camera', 'move')}
        >
          <video
            ref={camRef}
            className={s.camVideo}
            muted
            playsInline
            style={{ transform: camera.mirrored ? 'scaleX(-1)' : undefined }}
          />
          {selectedId === 'camera' && (
            <div className={s.handle} onPointerDown={(e) => onPointerDown(e, 'camera', 'resize')} />
          )}
        </div>
      )}

      {/* Shape controls appear on the camera itself when it's selected —
          no need to hunt through the panel to change it. Positioned above
          the camera, or below when it's near the top of the frame. */}
      {camera.enabled && camera.deviceId && hasCameraFeed && selectedId === 'camera' && !dragging && (
        <div
          className={s.shapeBar}
          style={{
            left: `${camera.rect.x * 100}%`,
            ...(camera.rect.y < 0.12
              ? { top: `calc(${(camera.rect.y + camera.rect.h) * 100}% + 6px)` }
              : { top: `calc(${camera.rect.y * 100}% - 34px)` }),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {SHAPES.map((sh) => (
            <Tooltip key={sh.id} content={sh.label} relationship="label" withArrow>
              <Button
                className={s.shapeBtn}
                size="small"
                appearance={camera.shape === sh.id ? 'primary' : 'subtle'}
                icon={sh.icon}
                onClick={() => onCameraShape(sh.id)}
              />
            </Tooltip>
          ))}
          <Tooltip content="Mirror" relationship="label" withArrow>
            <Button
              className={s.shapeBtn}
              size="small"
              appearance={camera.mirrored ? 'primary' : 'subtle'}
              icon={<FlipHorizontalRegular />}
              onClick={() => onCameraMirror(!camera.mirrored)}
            />
          </Tooltip>
        </div>
      )}

      {(camera.enabled || images.length > 0) && (
        <div className={s.hint}>
          <Text size={100}>Drag to move · corner handle to resize</Text>
        </div>
      )}
    </div>
  );
}
