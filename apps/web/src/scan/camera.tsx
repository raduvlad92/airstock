import { useCallback, useEffect, useRef, useState } from 'react';
import { createDecoder, type Decoded, type FrameDecoder } from './decoder.ts';

/**
 * The rear camera with continuous decoding (plan D13). It opens on a tap the first time; after
 * that the choice is remembered and the camera reopens with the page. It stops while the page is
 * hidden, so an installed app in the background does not hold the camera. Torch and zoom
 * controls appear only where the camera offers them (iOS 17.4+ for the torch on iPhone).
 */
const PREF_KEY = 'airstock.scan.camera';

type State =
  | { status: 'off' }
  | { status: 'starting' }
  | { status: 'running'; decoder: FrameDecoder['kind'] }
  | { status: 'error'; message: string };

interface TrackCapabilities {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
}

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

function writePref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // Not remembered in private mode.
  }
}

function cameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') {
    return 'Camera access was refused. Allow the camera for this site in Settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found. Type or scan codes into the field below.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot open the camera here. Use the field below.';
  }
  return error instanceof Error ? error.message : String(error);
}

export function CameraScanner({
  onDetected,
  paused = false,
  flash,
}: {
  onDetected: (code: Decoded) => void;
  /** While true, frames are not decoded, for example while a form waits for confirmation. */
  paused?: boolean;
  /** Colours the frame briefly after a scan: green for ok, red for an error. */
  flash?: 'ok' | 'error' | null;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const decoder = useRef<FrameDecoder | null>(null);
  const loop = useRef(0);
  const wanted = useRef(readPref());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const detected = useRef(onDetected);
  detected.current = onDetected;
  const [state, setState] = useState<State>({ status: 'off' });
  const [caps, setCaps] = useState<TrackCapabilities>({});
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);

  const stop = useCallback(() => {
    loop.current += 1;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setTorch(false);
  }, []);

  const start = useCallback(async () => {
    if (stream.current) return;
    setState({ status: 'starting' });
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      stream.current = media;
      const el = video.current;
      if (!el) {
        stop();
        return;
      }
      el.srcObject = media;
      await el.play();
      const track = media.getVideoTracks()[0];
      // iOS ends the stream when something else takes the camera, such as Quick add's photo
      // capture or a call; reopen it once the page is back.
      track?.addEventListener('ended', () => {
        if (stream.current !== media) return;
        stop();
        setState({ status: 'off' });
        if (wanted.current && !document.hidden) setTimeout(() => void start(), 400);
      });
      const capabilities = (track?.getCapabilities?.() ?? {}) as TrackCapabilities;
      setCaps(capabilities);
      const settings = (track?.getSettings?.() ?? {}) as { zoom?: number };
      setZoom(settings.zoom ?? null);
      decoder.current ??= await createDecoder();
      setState({ status: 'running', decoder: decoder.current.kind });
      const run = ++loop.current;
      const tick = async () => {
        if (run !== loop.current) return;
        const v = video.current;
        if (!pausedRef.current && v && v.readyState >= 2 && decoder.current) {
          try {
            for (const found of await decoder.current.decode(v)) {
              if (run !== loop.current) return;
              detected.current(found);
            }
          } catch {
            // A frame that cannot be read (for example while the camera refocuses) is skipped.
          }
        }
        setTimeout(tick, decoder.current?.kind === 'native' ? 90 : 40);
      };
      void tick();
    } catch (error) {
      stop();
      setState({ status: 'error', message: cameraError(error) });
    }
  }, [stop]);

  const toggle = useCallback(() => {
    if (stream.current) {
      wanted.current = false;
      writePref(false);
      stop();
      setState({ status: 'off' });
    } else {
      wanted.current = true;
      writePref(true);
      void start();
    }
  }, [start, stop]);

  useEffect(() => {
    if (wanted.current) void start();
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        setState({ status: 'off' });
      } else if (wanted.current) {
        void start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [start, stop]);

  const applyTorch = async (on: boolean) => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch(on);
    } catch {
      setCaps((c) => ({ ...c, torch: false }));
    }
  };

  const applyZoom = async (value: number) => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
      setZoom(value);
    } catch {
      setCaps((c) => ({ ...c, zoom: undefined }));
    }
  };

  const running = state.status === 'running';
  const flashClass = flash ? ` flash-${flash}` : '';
  return (
    <div className="scan-camera">
      <div className={`scan-viewport${running ? ' live' : ''}${flashClass}`}>
        {/* playsInline and muted keep iOS from opening the video full screen. */}
        <video ref={video} playsInline muted autoPlay aria-label="Camera" />
        {running ? <div className="scan-aim" aria-hidden="true" /> : null}
        {!running ? (
          <div className="scan-viewport-message">
            {state.status === 'starting' ? (
              <span>Opening the camera…</span>
            ) : state.status === 'error' ? (
              <span role="alert">{state.message}</span>
            ) : (
              <span>Camera off</span>
            )}
          </div>
        ) : null}
        {running && paused ? <div className="scan-paused">Paused</div> : null}
      </div>
      <div className="scan-camera-controls">
        <button type="button" className={running ? 'secondary' : ''} onClick={toggle}>
          {running ? 'Stop camera' : state.status === 'starting' ? 'Opening…' : 'Start camera'}
        </button>
        {running && caps.torch ? (
          <button
            type="button"
            className="secondary"
            aria-pressed={torch}
            onClick={() => void applyTorch(!torch)}
          >
            {torch ? 'Light off' : 'Light on'}
          </button>
        ) : null}
        {running && caps.zoom && caps.zoom.max > caps.zoom.min ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const z = caps.zoom!;
              const current = zoom ?? z.min;
              const next =
                current >= Math.min(z.max, 3) - 0.01 ? z.min : Math.min(z.max, current * 2 || 2);
              void applyZoom(next);
            }}
          >
            Zoom {zoom ? `${Math.round(zoom * 10) / 10}×` : '1×'}
          </button>
        ) : null}
        {running ? (
          <span className="muted small-text scan-decoder">
            {state.decoder === 'native' ? 'Built-in decoder' : 'zxing decoder'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
