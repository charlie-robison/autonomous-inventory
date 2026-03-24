"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface ScanResult {
  name: string;
  count: number;
}

type ViewState = "idle" | "recording" | "processing" | "results";

const MOCK_RESULTS: ScanResult[] = [
  { name: "Cardboard Box (Small)", count: 12 },
  { name: "Cardboard Box (Large)", count: 8 },
  { name: "Plastic Bin", count: 5 },
  { name: "Pallet", count: 3 },
  { name: "Shrink-Wrapped Bundle", count: 6 },
];

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [depth, setDepth] = useState("1");
  const [cameraError, setCameraError] = useState("");
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<ScanResult[]>([]);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraError("");
    } catch {
      setCameraError("Unable to access camera. Please allow camera permissions.");
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startCamera]);

  const startRecording = () => {
    if (!streamRef.current) return;

    chunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm",
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      handleRecordingComplete();
    };

    recorderRef.current = recorder;
    recorder.start();
    setViewState("recording");
    setElapsed(0);

    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    recorderRef.current?.stop();
    setViewState("processing");
  };

  const handleRecordingComplete = async () => {
    const blob = new Blob(chunksRef.current, { type: "video/webm" });

    // TODO: Replace mock with real API call
    void blob;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const mockWithDepth = MOCK_RESULTS.map((item) => ({
      ...item,
      count: item.count * Number(depth || 1),
    }));

    setResults(mockWithDepth);
    setViewState("results");
  };

  const handleScanAgain = () => {
    setResults([]);
    setElapsed(0);
    setViewState("idle");
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const totalItems = results.reduce((sum, r) => sum + r.count, 0);
  const isRecording = viewState === "recording";
  const isProcessing = viewState === "processing";

  // Results screen
  if (viewState === "results") {
    return (
      <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col">
        <div className="flex-1 overflow-auto">
          {/* Header */}
          <div className="sticky top-0 z-10 backdrop-blur-2xl bg-[#0a0a0f]/80 px-6 pt-14 pb-5">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              <p className="text-emerald-400 text-xs font-semibold uppercase tracking-widest">
                Scan Complete
              </p>
            </div>
            <h1 className="text-white text-3xl font-bold tracking-tight mt-2">
              {totalItems} <span className="text-white/40 font-normal text-lg">items found</span>
            </h1>
            <p className="text-white/30 text-sm mt-1">
              {results.length} types
              {Number(depth) > 1 && <span> &middot; {depth} layers deep</span>}
            </p>
          </div>

          {/* Item list */}
          <div className="px-5 pb-6 flex flex-col gap-2.5">
            {results.map((item, i) => (
              <div
                key={i}
                className="animate-fade-up flex items-center justify-between rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06] backdrop-blur-sm"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-white/[0.06] flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
                    </svg>
                  </div>
                  <span className="text-white/90 font-medium text-[15px] truncate">{item.name}</span>
                </div>
                <span className="text-white font-bold text-xl tabular-nums ml-4">
                  {item.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom actions */}
        <div className="relative z-20 px-5 pb-10 pt-4 safe-area-bottom">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleScanAgain}
              className="flex-1 h-[52px] rounded-2xl bg-white text-black font-semibold text-[15px] active:scale-[0.98] transition-transform"
            >
              Scan Again
            </button>
            <Link
              href="/inventory"
              className="flex-1 h-[52px] rounded-2xl bg-white/[0.07] border border-white/[0.1] text-white/80 font-semibold text-[15px] flex items-center justify-center active:scale-[0.98] transition-transform"
            >
              Inventory
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Camera / Recording / Processing view
  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      {/* Camera feed */}
      <div className="relative flex-1 overflow-hidden">
        {cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-5 rounded-3xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <svg
                  className="w-9 h-9 text-white/30"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
                  />
                </svg>
              </div>
              <p className="text-white/80 text-lg font-semibold mb-1.5">Camera Access Required</p>
              <p className="text-white/30 text-sm max-w-[260px] mx-auto leading-relaxed">{cameraError}</p>
            </div>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {/* Vignette overlay — always visible */}
        <div className="absolute inset-0 pointer-events-none z-[5]"
          style={{
            background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)",
          }}
        />

        {/* Scan guide overlay */}
        <div className="absolute inset-0 pointer-events-none z-10">
          {/* Top gradient */}
          <div className="absolute top-0 left-0 right-0 h-28 bg-gradient-to-b from-black/70 via-black/30 to-transparent" />
          {/* Bottom gradient */}
          <div className="absolute bottom-0 left-0 right-0 h-28 bg-gradient-to-t from-black/50 to-transparent" />

          {/* Viewfinder */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-72 h-72 relative">
              {/* Corner brackets */}
              {[
                "top-0 left-0 border-t-2 border-l-2 rounded-tl-2xl",
                "top-0 right-0 border-t-2 border-r-2 rounded-tr-2xl",
                "bottom-0 left-0 border-b-2 border-l-2 rounded-bl-2xl",
                "bottom-0 right-0 border-b-2 border-r-2 rounded-br-2xl",
              ].map((cls, i) => (
                <div
                  key={i}
                  className={`absolute w-12 h-12 ${cls} ${
                    isRecording
                      ? "border-red-400 animate-bracket-glow"
                      : "border-white/60"
                  } transition-colors duration-300`}
                />
              ))}

              {/* Scanning line (visible while recording) */}
              {isRecording && (
                <div className="absolute left-3 right-3 animate-scan-line">
                  <div className="h-[2px] bg-gradient-to-r from-transparent via-red-400 to-transparent shadow-[0_0_12px_rgba(248,113,113,0.5)]" />
                </div>
              )}
            </div>
          </div>

          {/* Status indicator */}
          <div className="absolute top-20 left-0 right-0 flex justify-center">
            {isRecording ? (
              <div className="flex items-center gap-2.5 bg-red-500/20 backdrop-blur-xl border border-red-500/30 rounded-full px-5 py-2">
                <div className="relative w-2.5 h-2.5">
                  <div className="absolute inset-0 rounded-full bg-red-400" />
                  <div className="absolute inset-0 rounded-full bg-red-400 animate-ping" />
                </div>
                <span className="text-red-300 text-sm font-semibold tabular-nums tracking-wide">
                  REC {formatTime(elapsed)}
                </span>
              </div>
            ) : isProcessing ? (
              <div className="flex items-center gap-2.5 bg-white/[0.06] backdrop-blur-xl border border-white/[0.1] rounded-full px-5 py-2">
                <svg className="w-4 h-4 text-white/60 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-white/60 text-sm font-medium">Analyzing...</span>
              </div>
            ) : (
              <p className="text-white/50 text-[13px] font-medium tracking-wide">
                Point camera at inventory items
              </p>
            )}
          </div>
        </div>

        {/* Nav links (hidden while recording) */}
        {viewState === "idle" && (
          <div className="absolute top-4 right-4 z-30 flex gap-2">
            <Link
              href="/stream"
              className="h-9 px-3.5 flex items-center gap-1.5 rounded-full bg-white/[0.08] backdrop-blur-xl border border-white/[0.12] text-white/70 text-[13px] font-medium transition-colors active:bg-white/[0.15]"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
              </svg>
              Live
            </Link>
            <Link
              href="/inventory"
              className="h-9 px-3.5 flex items-center gap-1.5 rounded-full bg-white/[0.08] backdrop-blur-xl border border-white/[0.12] text-white/70 text-[13px] font-medium transition-colors active:bg-white/[0.15]"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
              </svg>
              Items
            </Link>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="relative z-20 bg-gradient-to-t from-black via-black/95 to-black/80 px-6 pb-10 pt-6 safe-area-bottom">
        {/* Depth input (hidden while recording/processing) */}
        {viewState === "idle" && (
          <div className="flex items-center justify-center gap-3 mb-7">
            <label className="text-white/30 text-[13px] font-medium uppercase tracking-widest">
              Depth
            </label>
            <div className="flex items-center bg-white/[0.06] border border-white/[0.08] rounded-2xl overflow-hidden">
              <button
                type="button"
                onClick={() => setDepth((d) => String(Math.max(1, Number(d) - 1)))}
                className="w-12 h-12 flex items-center justify-center text-white/50 text-xl font-light active:bg-white/[0.06] transition-colors"
              >
                &minus;
              </button>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
                className="w-12 h-12 bg-transparent text-white text-center text-lg font-bold outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() => setDepth((d) => String(Number(d) + 1))}
                className="w-12 h-12 flex items-center justify-center text-white/50 text-xl font-light active:bg-white/[0.06] transition-colors"
              >
                +
              </button>
            </div>
          </div>
        )}

        {/* Recording hint */}
        {isRecording && (
          <p className="text-white/25 text-[11px] text-center mb-6 uppercase tracking-widest font-medium">
            Tap to stop
          </p>
        )}

        {/* Processing hint */}
        {isProcessing && (
          <div className="h-1 mx-auto max-w-[200px] rounded-full overflow-hidden mb-6 bg-white/[0.06]">
            <div className="h-full w-full animate-shimmer rounded-full" />
          </div>
        )}

        {/* Record / Stop button */}
        <div className="flex items-center justify-center">
          <button
            type="button"
            onClick={viewState === "idle" ? startRecording : isRecording ? stopRecording : undefined}
            disabled={!!cameraError || isProcessing}
            className="group relative w-[76px] h-[76px] rounded-full flex items-center justify-center disabled:opacity-30"
          >
            {/* Pulse ring when recording */}
            {isRecording && (
              <div className="absolute inset-0 rounded-full border-2 border-red-400/40 animate-pulse-ring" />
            )}
            {/* Outer ring */}
            <div
              className={`absolute inset-0 rounded-full border-[3px] transition-all duration-300 ${
                isRecording ? "border-red-400/80 scale-110" : "border-white/80"
              }`}
            />
            {/* Inner shape */}
            {isRecording ? (
              <div className="w-7 h-7 rounded-[6px] bg-red-400 group-active:scale-90 transition-all duration-200 shadow-[0_0_20px_rgba(248,113,113,0.4)]" />
            ) : (
              <div
                className={`rounded-full transition-all duration-200 ${
                  isProcessing
                    ? "w-14 h-14 bg-white/20"
                    : "w-[62px] h-[62px] bg-white group-active:scale-[0.92] group-active:bg-white/80"
                }`}
              />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
