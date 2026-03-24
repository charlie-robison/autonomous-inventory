"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface ScanResult {
  name: string;
  count: number;
}

type ViewState = "idle" | "recording" | "processing" | "results";
type AppMode = "count" | "receive" | "load";

const API_BASE = "http://localhost:8000";

const MODE_COLORS: Record<AppMode, string> = {
  count: "bg-emerald-500/20 border-emerald-500/30 text-emerald-300",
  receive: "bg-blue-500/20 border-blue-500/30 text-blue-300",
  load: "bg-amber-500/20 border-amber-500/30 text-amber-300",
};

const MODE_DOT_COLORS: Record<AppMode, string> = {
  count: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]",
  receive: "bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)]",
  load: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]",
};

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

  // Mode state
  const [appMode, setAppMode] = useState<AppMode>("count");
  const [isListening, setIsListening] = useState(false);
  const [modeStatus, setModeStatus] = useState<string>("");
  const listeningRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Poll current mode from backend
  useEffect(() => {
    const fetchMode = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/mode`);
        if (res.ok) {
          const data = await res.json();
          setAppMode(data.current_mode as AppMode);
        }
      } catch {
        // Backend may not be running yet
      }
    };

    fetchMode();
    const interval = setInterval(fetchMode, 5000);
    return () => clearInterval(interval);
  }, []);

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

  // Always-on voice listening for mode selection.
  // Starts automatically on mount, records in 2-second segments,
  // and changes mode whenever a keyword is heard.
  const startListening = useCallback(async () => {
    if (listeningRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setModeStatus("Microphone access denied");
      return;
    }

    micStreamRef.current = stream;
    listeningRef.current = true;
    setIsListening(true);
    setModeStatus("Say 'Jarvis' + mode...");

    // Loop forever: record 2s segments and check for mode keywords
    while (listeningRef.current) {
      const text = await recordAndTranscribe(stream);

      if (!listeningRef.current) break;
      if (!text || !text.trim()) continue;

      const modeMatch = detectMode(text);
      if (modeMatch) {
        setModeStatus(`Heard "${text}" — setting ${modeMatch}...`);

        try {
          const res = await fetch(`${API_BASE}/api/mode/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.matched) {
              setAppMode(data.mode as AppMode);
              setModeStatus(`Mode: ${data.mode}`);
            }
          }
        } catch {
          setModeStatus("Failed to set mode");
        }

        // Brief pause after setting mode so the status is visible,
        // then resume listening for the next command
        await new Promise((r) => setTimeout(r, 1500));
        if (listeningRef.current) setModeStatus("Say 'Jarvis' + mode...");
      }
    }

    // Cleanup (only if explicitly stopped)
    stream.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setIsListening(false);
  }, []);

  // Auto-start listening on mount
  useEffect(() => {
    startListening();
    return () => {
      listeningRef.current = false;
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, [startListening]);

  /** Record a ~2s audio segment from the stream and return transcribed text. */
  const recordAndTranscribe = (stream: MediaStream): Promise<string> => {
    return new Promise((resolve) => {
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        if (!chunks.length) { resolve(""); return; }

        try {
          const blob = new Blob(chunks, { type: "audio/webm" });
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext({ sampleRate: 16000 });
          const decoded = await audioCtx.decodeAudioData(arrayBuffer);
          const pcmFloat = decoded.getChannelData(0);

          // Normalize quiet audio: boost so peak reaches ~90% of max
          const peak = pcmFloat.reduce((mx, v) => Math.max(mx, Math.abs(v)), 0);
          const gain = peak > 0 && peak < 0.25 ? 0.9 / peak : 1;

          // Float32 -> Int16 with gain applied
          const pcm16 = new Int16Array(pcmFloat.length);
          for (let i = 0; i < pcmFloat.length; i++) {
            const s = Math.max(-1, Math.min(1, pcmFloat[i] * gain));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }

          // Transcribe via WebSocket
          const text = await transcribeViaWs(pcm16);
          audioCtx.close();
          resolve(text);
        } catch {
          resolve("");
        }
      };

      recorder.start();
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 2000);
    });
  };

  /** Send PCM to the audio WebSocket and get transcription back. */
  const transcribeViaWs = (pcm16: Int16Array): Promise<string> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:8000/ws/audio-stream`);
      const timeout = setTimeout(() => { ws.close(); resolve(""); }, 10000);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "status" && msg.message === "ready") {
          ws.send(pcm16.buffer);
          ws.send(JSON.stringify({ action: "transcribe" }));
        } else if (msg.type === "transcription") {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.text || "");
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          ws.close();
          resolve("");
        }
      };

      ws.onerror = () => { clearTimeout(timeout); resolve(""); };
    });
  };

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

        {/* Mode indicator + nav links */}
        {viewState === "idle" && (
          <>
            {/* Mode badge + mic indicator — top left */}
            <div className="absolute top-4 left-4 z-30">
              <div className={`flex items-center gap-2 rounded-full px-3.5 py-2 border backdrop-blur-xl ${MODE_COLORS[appMode]}`}>
                <div className={`w-2 h-2 rounded-full ${MODE_DOT_COLORS[appMode]}`} />
                <span className="text-[13px] font-semibold uppercase tracking-widest">
                  {appMode}
                </span>
                {isListening && (
                  <svg className="w-3.5 h-3.5 opacity-60 animate-pulse ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                  </svg>
                )}
              </div>
              {modeStatus && (
                <p className="mt-1.5 text-[11px] text-white/40 max-w-[200px] leading-tight pl-1">
                  {modeStatus}
                </p>
              )}
            </div>

            {/* Nav links — top right */}
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
          </>
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

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  if (a.length < b.length) return levenshtein(b, a);
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr.push(Math.min(
        prev[j + 1] + 1,
        curr[j] + 1,
        prev[j] + (a[i] !== b[j] ? 1 : 0),
      ));
    }
    prev = curr;
  }
  return prev[b.length];
}

const WAKE_RE = /\b(jarvis|jarvas|jarves|jarvus|jarv[iy]s|jarbus|gervis|jervis|jarv|jarb[iy]s|jarfis|jarbis|service|java[s']?|travis|elvis)\b/i;

const MODE_ANCHORS: Record<AppMode, string[]> = {
  receive: ["receive", "receiving", "received", "reseive", "recieve", "resiv", "receipt", "recede", "believe", "retrieve", "receiv"],
  load: ["load", "loading", "loaded", "lode", "lowed", "loud", "loat", "lote", "lord", "lod", "loader"],
  count: ["count", "counting", "counted", "cound", "mount", "caunt", "cant", "kount", "coun", "recount", "account", "county", "counter"],
};

/** Detect wake word + fuzzy-match mode from transcribed text. */
function detectMode(text: string): AppMode | null {
  const match = WAKE_RE.exec(text);
  if (!match) return null;

  const after = text.slice(match.index + match[0].length).trim();
  if (!after) return null;

  const words = after.toLowerCase().match(/[a-z]+/g);
  if (!words) return null;

  let bestMode: AppMode | null = null;
  let bestDist = 999;

  for (const [mode, anchors] of Object.entries(MODE_ANCHORS) as [AppMode, string[]][]) {
    for (const word of words) {
      for (const anchor of anchors) {
        const d = levenshtein(word, anchor);
        if (d < bestDist) {
          bestDist = d;
          bestMode = mode;
        }
      }
    }
  }

  return bestDist <= 3 ? bestMode : null;
}

/**
 * Encode 16-bit PCM samples into a WAV file buffer.
 */
function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  const offset = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset + i * 2, samples[i], true);
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
