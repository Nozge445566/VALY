import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { TEXTS } from "@/lib/texts";

interface Props {
  /** A photo taken with the camera. */
  onCapture: (photo: string) => void;
  /** A photo picked from the gallery. The app prepares it (shrinks it only when it is too big). */
  onGalleryFile: (file: File) => void;
}

type Status = "idle" | "starting" | "live" | "denied" | "unsupported";

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      if (video.videoWidth > 1) resolve();
      else reject(new Error(TEXTS.camera.frameEmpty));
    };
    const onErr = () => {
      cleanup();
      reject(new Error(TEXTS.camera.previewFailed));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("error", onErr);
      clearTimeout(timer);
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    video.addEventListener("error", onErr);
    const timer = window.setTimeout(onReady, 2500);
  });
}

export function CameraView({ onCapture, onGalleryFile }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [flash, setFlash] = useState(0);
  const capturing = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number; key: number } | null>(null);
  const focusTimer = useRef<number | null>(null);
  const focusReset = useRef<number | null>(null);

  useEffect(() => {
    if (status !== "live") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});
    waitForFrame(video).then(() => setReady(true)).catch(() => setReady(true));
  }, [status]);

  async function startCamera() {
    if (status === "live" || status === "starting") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      setError(TEXTS.camera.unsupported);
      return;
    }
    setStatus("starting");
    setError(null);
    setReady(false);
    try {
      const attempts: MediaStreamConstraints[] = [
        { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
        { audio: false, video: { facingMode: "user" } },
        { audio: false, video: true },
      ];
      let stream: MediaStream | null = null;
      let last: unknown = null;
      for (const constraints of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (e) {
          last = e;
        }
      }
      if (!stream) throw last ?? new Error("No camera");
      streamRef.current = stream;
      setStatus("live");
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setStatus("denied");
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? TEXTS.camera.blocked
          : TEXTS.camera.couldNotOpen,
      );
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
    setStatus("idle");
  }

  useEffect(() => {
    return () => {
      if (focusTimer.current) window.clearTimeout(focusTimer.current);
      if (focusReset.current) window.clearTimeout(focusReset.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  /**
   * Tap to focus. A single tap on the picture asks the camera to focus on that spot, and a small ring shows where.
   * The ring always shows (instant feedback). The camera itself is asked only if the phone/browser supports it:
   * Chrome on Android does; iPhone Safari does not let websites control focus, so there the ring is only visual and
   * the camera keeps using its own automatic focus. Every call is wrapped so a failure can never disturb the camera.
   */
  function handleFocusTap(e: ReactMouseEvent<HTMLDivElement>) {
    if (status !== "live" || capturing.current) return;
    // Taps on buttons (shutter, upload, close) are not focus taps.
    if ((e.target as HTMLElement).closest("button")) return;
    const box = boxRef.current;
    const video = videoRef.current;
    if (!box || !video) return;

    const rect = box.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Show the ring where the finger landed.
    setFocusPoint({ x: px, y: py, key: Date.now() });
    if (focusTimer.current) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => setFocusPoint(null), 900);

    // The picture is cropped to fill the box (object-cover), so map the tap back to a point in the real camera frame.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw < 2 || vh < 2 || rect.width < 1 || rect.height < 1) return;
    const scale = Math.max(rect.width / vw, rect.height / vh);
    const shownW = vw * scale;
    const shownH = vh * scale;
    const nx = Math.min(1, Math.max(0, (px + (shownW - rect.width) / 2) / shownW));
    const ny = Math.min(1, Math.max(0, (py + (shownH - rect.height) / 2) / shownH));

    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
      const modes = caps.focusMode ?? [];
      // "single-shot" = focus once on the point. Otherwise a "continuous" nudge makes many cameras re-focus.
      const mode = modes.includes("single-shot") ? "single-shot" : modes.includes("continuous") ? "continuous" : null;
      if (!mode) return; // this camera/browser does not allow focus control: the ring is only visual
      const advanced = { focusMode: mode, pointsOfInterest: [{ x: nx, y: ny }] } as unknown as MediaTrackConstraintSet;
      track
        .applyConstraints({ advanced: [advanced] })
        .then(() => {
          // After a single-shot focus, go back to automatic focus so the picture stays sharp if the person moves.
          if (mode === "single-shot" && modes.includes("continuous")) {
            if (focusReset.current) window.clearTimeout(focusReset.current);
            focusReset.current = window.setTimeout(() => {
              const t = streamRef.current?.getVideoTracks()[0];
              const back = { focusMode: "continuous" } as unknown as MediaTrackConstraintSet;
              t?.applyConstraints({ advanced: [back] }).catch(() => {});
            }, 2500);
          }
        })
        .catch(() => {}); // not supported after all: ignore, the camera keeps its own focus
    } catch {
      // never let focus trouble affect the camera
    }
  }

  /**
   * Capture is instant and exact: the frame is copied from the live preview in the same tick as the tap, so the photo is
   * what the person saw at that moment, however much they move afterwards. (The old route asked the camera hardware for a
   * separate still, which took up to a second or two and could catch a blurred or different scene.)
   * The preview freezes on that frame at once, a short shutter flash confirms it, and the app moves on.
   */
  function snap() {
    const video = videoRef.current;
    if (!video || status !== "live" || capturing.current) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w < 2 || h < 2) {
      setError(TEXTS.camera.notReady);
      return;
    }
    capturing.current = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(TEXTS.camera.couldNotCapture);
      ctx.drawImage(video, 0, 0, w, h); // nothing is awaited before this line: the frame is the tap's frame
      video.pause(); // freeze the preview on exactly that frame
      setBusy(true);
      setFlash((n) => n + 1);
      navigator.vibrate?.(10);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      // The photo is already locked in. A beat of frozen frame and flash is the shutter moment, then the app moves on.
      window.setTimeout(() => {
        onCapture(dataUrl);
        stopCamera();
        capturing.current = false;
        setBusy(false);
      }, 170);
    } catch (e) {
      video.play().catch(() => {});
      setError(e instanceof Error ? e.message : TEXTS.camera.couldNotTake);
      capturing.current = false;
      setBusy(false);
    }
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    stopCamera();
    onGalleryFile(file);
  }

  if (status === "idle") {
    return (
      <div className="relative flex h-full w-full flex-col px-[5cqw] pb-[7cqw] text-center font-display">
        <div className="vaur" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="relative z-10 my-auto pb-[14cqw]">
          <h1 className="font-medium leading-none tracking-[-0.07em]" style={{ fontSize: "31cqw" }} aria-label="Valy">
            {[..."Valy"].map((ch, k) => (
              <span key={k} className="vch" style={{ "--k": k } as React.CSSProperties} aria-hidden="true">
                {ch}
              </span>
            ))}
          </h1>
          <p className="vtag mt-[3cqw] text-[4.4cqw] text-mist">{TEXTS.app.welcomeTag}</p>
        </div>

        <button type="button" onClick={startCamera} className="vbtn btn-cream relative z-10 font-display">
          {TEXTS.camera.open}
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="vbtn relative z-10 mt-[5.3cqw] text-[16px] font-medium tracking-[-0.01em] text-cream"
        >
          {TEXTS.camera.uploadAlt}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
    );
  }

  return (
    <div className="h-full w-full p-3">
    <div
      ref={boxRef}
      onClick={handleFocusTap}
      className="relative flex h-full min-h-[280px] w-full flex-col overflow-hidden rounded-[1.75rem] bg-[#060a18]"
    >
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className={`absolute inset-0 h-full w-full object-cover ${status === "live" ? "block" : "hidden"}`}
      />

      {status !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-mist">
          {status === "starting" ? (
            <>
              <Loader2 size={26} className="animate-spin text-cream" />
              <p className="text-sm">{TEXTS.camera.opening}</p>
            </>
          ) : (
            <>
              <Camera size={28} className="text-dusk" />
              <p className="text-sm text-mist">{error}</p>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-2 inline-flex items-center gap-2 rounded-full bg-white/[0.08] px-4 py-2 text-sm text-cream hover:bg-white/[0.14] transition"
              >
                <ImagePlus size={16} /> {TEXTS.camera.uploadPhoto}
              </button>
            </>
          )}
        </div>
      )}

      {status === "live" && (
        <>
          {flash > 0 && <div key={flash} className="shutter-flash pointer-events-none absolute inset-0 z-20 bg-white" />}
          {focusPoint && (
            <div
              key={focusPoint.key}
              className="focus-ring pointer-events-none absolute z-10 h-[4.5rem] w-[4.5rem] rounded-full border-2 border-[#f5eddc]"
              style={{ left: focusPoint.x, top: focusPoint.y }}
            />
          )}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[58%] w-[78%] rounded-[1.6rem] border border-white/20 shadow-[0_0_0_2000px_rgba(0,0,0,0.28)]" />
          </div>
          <p className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1 text-xs text-cream backdrop-blur">
            {TEXTS.camera.center}
          </p>
          <button
            type="button"
            onClick={stopCamera}
            className="absolute top-4 left-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70 transition"
            aria-label={TEXTS.camera.close}
          >
            <X size={18} />
          </button>
          {error && (
            <p className="absolute top-16 left-1/2 z-10 w-[80%] -translate-x-1/2 text-center text-xs text-amber-200/90">
              {error}
            </p>
          )}
          <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-8 bg-gradient-to-t from-black/80 to-transparent px-6 pb-5 pt-10">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="grid h-12 w-12 place-items-center rounded-full bg-white/[0.1] text-cream hover:bg-white/[0.18] transition"
              aria-label={TEXTS.camera.uploadPhoto}
            >
              <ImagePlus size={20} />
            </button>
            <button
              type="button"
              onClick={snap}
              disabled={!ready}
              className="grid place-items-center rounded-full border-[3px] border-white/85 bg-white/10 text-white disabled:opacity-40 active:scale-95 transition"
              style={{ width: 72, height: 72 }}
              aria-label={TEXTS.camera.takePhoto}
            >
              {busy ? (
                <Loader2 size={26} className="animate-spin" />
              ) : (
                <span className="rounded-full bg-white" style={{ width: 54, height: 54 }} />
              )}
            </button>
            <span className="h-12 w-12" />
          </div>
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
    </div>
  );
}
