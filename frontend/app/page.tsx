"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface ScanResult {
  name: string;
  count: number;
}

type ViewState =
  | "idle"
  | "processing"
  | "results"
  | "pending-approval";   // all data collected, user reviews before confirming
type AppMode = "count" | "receive" | "load";

const API_BASE = typeof window !== "undefined"
  ? `${window.location.protocol}//${window.location.host}`
  : "";
const WS_BASE = typeof window !== "undefined"
  ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
  : "ws://localhost:8000";

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


export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraError, setCameraError] = useState("");
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [results, setResults] = useState<ScanResult[]>([]);

  // Scanned values for load / receive (collected step-by-step, shown for approval)
  const [scannedPalletId, setScannedPalletId] = useState<string | null>(null);
  const [scannedVehicleName, setScannedVehicleName] = useState<string | null>(null);
  const [apiResult, setApiResult] = useState<Record<string, unknown> | null>(null);
  const [apiError, setApiError] = useState("");

  // GPS state for receive mode
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsError, setGpsError] = useState("");

  // Mode state
  const [appMode, setAppMode] = useState<AppMode>("count");
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
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
    };
  }, [startCamera]);

  // Auto-detect GPS when in receive mode
  useEffect(() => {
    if (appMode !== "receive") return;
    if (!navigator.geolocation) {
      setGpsError("Geolocation not supported");
      return;
    }
    setGpsError("");
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGpsError("");
      },
      (err) => setGpsError(`GPS error: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [appMode]);

  // Always-on voice listening for mode selection.
  // Uses ScriptProcessor to capture raw PCM (works on iOS Safari),
  // sends 2-second segments to the server for transcription.
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

    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(stream);
    let pcmBuffer: Float32Array[] = [];

    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!listeningRef.current) return;
      pcmBuffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);

    while (listeningRef.current) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!listeningRef.current) break;

      const chunks = pcmBuffer;
      pcmBuffer = [];
      if (!chunks.length) continue;

      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const pcmFloat = new Float32Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) { pcmFloat.set(chunk, offset); offset += chunk.length; }

      const peak = pcmFloat.reduce((mx, v) => Math.max(mx, Math.abs(v)), 0);
      if (peak < 0.01) continue; // skip silence

      const gain = peak > 0 && peak < 0.25 ? 0.9 / peak : 1;
      const pcm16 = new Int16Array(pcmFloat.length);
      for (let i = 0; i < pcmFloat.length; i++) {
        const s = Math.max(-1, Math.min(1, pcmFloat[i] * gain));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      setIsTranscribing(true);
      let text = "";
      try {
        text = await doTranscribe(pcm16);
      } catch { /* ignore */ }
      setIsTranscribing(false);

      if (!listeningRef.current) break;
      if (!text.trim()) continue;

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
        await new Promise((r) => setTimeout(r, 1500));
        if (listeningRef.current) setModeStatus("Say 'Jarvis' + mode...");
      }
    }

    processor.disconnect();
    source.disconnect();
    audioCtx.close();
    stream.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setIsListening(false);
  }, []);

  useEffect(() => {
    startListening();
    return () => {
      listeningRef.current = false;
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, [startListening]);


  /** Capture a JPEG frame from the live video feed. */
  const captureFrame = async (): Promise<ArrayBuffer> => {
    const video = videoRef.current!;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.85)
    );
    return blob.arrayBuffer();
  };

  /** Send a frame to a detection-only WebSocket and return the parsed response. */
  const sendToWs = (wsPath: string, imageBytes: ArrayBuffer): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/api/stream/ws/${wsPath}`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 15000);

      ws.onopen = () => ws.send(new Uint8Array(imageBytes));
      ws.onmessage = (event) => {
        clearTimeout(timeout);
        const data = JSON.parse(event.data);
        ws.close();
        resolve(data);
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket error")); };
    });
  };

  /** Count mode: capture → VLM count → show results. */
  const handleCountCapture = async () => {
    if (!videoRef.current) return;
    setViewState("processing");
    try {
      const frame = await captureFrame();
      const data = await sendToWs("count", frame);
      const items = ((data.items_updated as Array<{ name: string; count: number }>) || []).map(
        (item) => ({ name: item.name, count: item.count })
      );
      setResults(items);
      setViewState("results");
    } catch {
      setViewState("idle");
    }
  };

  /** Receive mode: capture → scan QR → go to approval. */
  const handleReceiveCapture = async () => {
    if (!videoRef.current) return;
    if (!gpsCoords) {
      setGpsError("Waiting for GPS coordinates...");
      return;
    }
    setViewState("processing");
    try {
      const frame = await captureFrame();
      const data = await sendToWs("scan-qr", frame);
      if (data.status === "ok" && data.pallet_id) {
        setScannedPalletId(data.pallet_id as string);
        setViewState("pending-approval");
      } else {
        setApiError((data.message as string) || "No QR code detected");
        setViewState("idle");
      }
    } catch {
      setViewState("idle");
    }
  };

  /**
   * Load mode: capture → try BOTH scan-qr and scan-vehicle in parallel.
   * Accumulates detections — stays on camera until both are found,
   * then auto-transitions to approval.
   */
  const handleLoadCapture = async () => {
    if (!videoRef.current) return;
    setViewState("processing");
    setApiError("");
    try {
      const frame = await captureFrame();

      // Fire both detections in parallel
      const [qrResult, vehicleResult] = await Promise.allSettled([
        sendToWs("scan-qr", frame),
        sendToWs("scan-vehicle", frame),
      ]);

      let newPalletId = scannedPalletId;
      let newVehicleName = scannedVehicleName;

      if (qrResult.status === "fulfilled" && qrResult.value.status === "ok" && qrResult.value.pallet_id) {
        newPalletId = qrResult.value.pallet_id as string;
        setScannedPalletId(newPalletId);
      }
      if (vehicleResult.status === "fulfilled" && vehicleResult.value.status === "ok" && vehicleResult.value.vehicle_name) {
        newVehicleName = vehicleResult.value.vehicle_name as string;
        setScannedVehicleName(newVehicleName);
      }

      // If both are now known, go to approval
      if (newPalletId && newVehicleName) {
        setViewState("pending-approval");
      } else {
        setViewState("idle");
      }
    } catch {
      setViewState("idle");
    }
  };

  /** User confirmed — call the REST API to execute the pipeline. */
  const handleApprove = async () => {
    setViewState("processing");
    setApiError("");
    try {
      let res: Response;
      if (appMode === "load") {
        res = await fetch(`${API_BASE}/api/pallets/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pallet_id: scannedPalletId,
            vehicle_name: scannedVehicleName,
          }),
        });
      } else {
        res = await fetch(`${API_BASE}/api/pallets/receive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pallet_id: scannedPalletId,
            lat: gpsCoords!.lat,
            lon: gpsCoords!.lon,
          }),
        });
      }
      const data = await res.json();
      if (data.error) {
        setApiError(data.error);
        setViewState("pending-approval");
      } else {
        setApiResult(data);
        setViewState("results");
      }
    } catch (e) {
      setApiError(`Request failed: ${e}`);
      setViewState("pending-approval");
    }
  };

  const handleScanAgain = () => {
    setResults([]);
    setScannedPalletId(null);
    setScannedVehicleName(null);
    setApiResult(null);
    setApiError("");
    setViewState("idle");
  };

  const totalItems = results.reduce((sum, r) => sum + r.count, 0);
  const isProcessing = viewState === "processing";

  // Mode-specific instruction text
  const getInstruction = (): string => {
    if (appMode === "count") return "Point camera at inventory items";
    if (appMode === "receive") return "Scan the QR code on the pallet";
    // load — tell the user what's still missing
    if (scannedPalletId && !scannedVehicleName) return "Now scan the vehicle number";
    if (!scannedPalletId && scannedVehicleName) return "Now scan the QR code on the pallet";
    return "Scan the pallet QR code or vehicle number";
  };

  const handleCapture = () => {
    if (appMode === "count") return handleCountCapture();
    if (appMode === "load") return handleLoadCapture();
    return handleReceiveCapture();
  };

  // -----------------------------------------------------------------------
  // Pending-approval screen (load + receive modes)
  // -----------------------------------------------------------------------
  if (viewState === "pending-approval") {
    const isLoad = appMode === "load";
    const accentColor = isLoad ? "amber" : "blue";
    return (
      <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col">
        <div className="flex-1 overflow-auto">
          <div className="sticky top-0 z-10 backdrop-blur-2xl bg-[#0a0a0f]/80 px-6 pt-14 pb-5">
            <div className="flex items-center gap-3 mb-1">
              <div className={`w-2 h-2 rounded-full bg-${accentColor}-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]`} />
              <p className={`text-${accentColor}-400 text-xs font-semibold uppercase tracking-widest`}>
                Confirm {isLoad ? "Load" : "Receive"}
              </p>
            </div>
            <h1 className="text-white text-2xl font-bold tracking-tight mt-2">
              Review &amp; Approve
            </h1>
            <p className="text-white/30 text-sm mt-1">
              Verify the scanned data below before confirming.
            </p>
          </div>

          <div className="px-5 pb-6 flex flex-col gap-2.5">
            {/* Pallet ID (always shown) */}
            <div className="animate-fade-up rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06]">
              <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">Pallet ID (QR)</p>
              <p className="text-white/90 text-sm font-mono">{scannedPalletId}</p>
            </div>

            {/* Vehicle name (load only) */}
            {isLoad && (
              <div className="animate-fade-up rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06]" style={{ animationDelay: "80ms" }}>
                <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">Vehicle Number</p>
                <p className="text-white/90 text-sm font-mono">{scannedVehicleName}</p>
              </div>
            )}

            {/* GPS + resolved warehouse (receive only) */}
            {!isLoad && gpsCoords && (
              <>
                <div className="animate-fade-up rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06]" style={{ animationDelay: "80ms" }}>
                  <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">GPS Location</p>
                  <p className="text-white/90 text-sm font-mono">
                    {gpsCoords.lat.toFixed(4)}, {gpsCoords.lon.toFixed(4)}
                  </p>
                </div>
              </>
            )}

            {apiError && (
              <div className="rounded-2xl px-5 py-4 bg-red-500/10 border border-red-500/20">
                <p className="text-red-400 text-sm">{apiError}</p>
              </div>
            )}
          </div>
        </div>

        {/* Approve / Cancel */}
        <div className="relative z-20 px-5 pb-10 pt-4 safe-area-bottom">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleApprove}
              className={`flex-1 h-[52px] rounded-2xl font-semibold text-[15px] active:scale-[0.98] transition-transform ${
                isLoad
                  ? "bg-amber-500 text-black"
                  : "bg-blue-500 text-white"
              }`}
            >
              Confirm {isLoad ? "Load" : "Receive"}
            </button>
            <button
              type="button"
              onClick={handleScanAgain}
              className="flex-1 h-[52px] rounded-2xl bg-white/[0.07] border border-white/[0.1] text-white/80 font-semibold text-[15px] active:scale-[0.98] transition-transform"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Results screen (after successful pipeline execution)
  // -----------------------------------------------------------------------
  if (viewState === "results") {
    return (
      <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col">
        <div className="flex-1 overflow-auto">
          <div className="sticky top-0 z-10 backdrop-blur-2xl bg-[#0a0a0f]/80 px-6 pt-14 pb-5">
            {appMode === "count" && (
              <>
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                  <p className="text-emerald-400 text-xs font-semibold uppercase tracking-widest">
                    Scan Complete
                  </p>
                </div>
                <h1 className="text-white text-3xl font-bold tracking-tight mt-2">
                  {totalItems} <span className="text-white/40 font-normal text-lg">items found</span>
                </h1>
                <p className="text-white/30 text-sm mt-1">{results.length} types</p>
              </>
            )}

            {appMode === "load" && (
              <>
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
                  <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest">
                    Pallet Loaded
                  </p>
                </div>
                <h1 className="text-white text-2xl font-bold tracking-tight mt-2">
                  Load Complete
                </h1>
              </>
            )}

            {appMode === "receive" && (
              <>
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)]" />
                  <p className="text-blue-400 text-xs font-semibold uppercase tracking-widest">
                    Pallet Received
                  </p>
                </div>
                <h1 className="text-white text-2xl font-bold tracking-tight mt-2">
                  Receive Complete
                </h1>
              </>
            )}
          </div>

          <div className="px-5 pb-6 flex flex-col gap-2.5">
            {/* Count mode items */}
            {appMode === "count" &&
              results.map((item, i) => (
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
                  <span className="text-white font-bold text-xl tabular-nums ml-4">{item.count}</span>
                </div>
              ))}

            {/* Load / Receive mode: show confirmed result */}
            {(appMode === "load" || appMode === "receive") && apiResult && (
              <>
                <div className="animate-fade-up rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06]">
                  <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">Pallet</p>
                  <p className="text-white/90 text-sm font-mono">{String(apiResult.name || scannedPalletId)}</p>
                </div>
                {appMode === "load" && (
                  <div className="animate-fade-up rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06]" style={{ animationDelay: "80ms" }}>
                    <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">Vehicle</p>
                    <p className="text-white/90 text-sm font-mono">{scannedVehicleName}</p>
                  </div>
                )}
                {appMode === "receive" && apiResult.warehouse_name && (
                  <div className="animate-fade-up rounded-2xl px-5 py-4 bg-white/[0.03] border border-white/[0.06]" style={{ animationDelay: "80ms" }}>
                    <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">Warehouse</p>
                    <p className="text-white/90 text-sm font-mono">HFA {String(apiResult.warehouse_name)}</p>
                  </div>
                )}
                <div
                  className={`animate-fade-up rounded-2xl px-5 py-4 ${
                    appMode === "load"
                      ? "bg-amber-500/10 border border-amber-500/20"
                      : "bg-blue-500/10 border border-blue-500/20"
                  }`}
                  style={{ animationDelay: appMode === "load" ? "160ms" : "160ms" }}
                >
                  <p className={`text-[11px] uppercase tracking-wider mb-1 ${appMode === "load" ? "text-amber-400" : "text-blue-400"}`}>
                    Status
                  </p>
                  <p className={`text-sm font-semibold ${appMode === "load" ? "text-amber-300" : "text-blue-300"}`}>
                    {String(apiResult.status || (appMode === "load" ? "loaded" : "received")).toUpperCase()}
                  </p>
                </div>
              </>
            )}
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
                    isProcessing
                      ? "border-red-400 animate-bracket-glow"
                      : "border-white/60"
                  } transition-colors duration-300`}
                />
              ))}

              {/* Scanning line (visible while processing) */}
              {isProcessing && (
                <div className="absolute left-3 right-3 animate-scan-line">
                  <div className="h-[2px] bg-gradient-to-r from-transparent via-red-400 to-transparent shadow-[0_0_12px_rgba(248,113,113,0.5)]" />
                </div>
              )}
            </div>
          </div>

          {/* Status indicator */}
          <div className="absolute top-20 left-0 right-0 flex flex-col items-center gap-2">
            {isProcessing ? (
              <div className="flex items-center gap-2.5 bg-white/[0.06] backdrop-blur-xl border border-white/[0.1] rounded-full px-5 py-2">
                <svg className="w-4 h-4 text-white/60 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-white/60 text-sm font-medium">Scanning...</span>
              </div>
            ) : (
              <p className="text-white/50 text-[13px] font-medium tracking-wide text-center px-8">
                {getInstruction()}
              </p>
            )}
            {/* Load mode: show detected values as badges */}
            {appMode === "load" && !isProcessing && (
              <div className="flex flex-col items-center gap-1.5 mt-1">
                <div className={`flex items-center gap-2 backdrop-blur-xl rounded-full px-4 py-1.5 border ${scannedPalletId ? "bg-amber-500/15 border-amber-500/25" : "bg-white/[0.04] border-white/[0.08]"}`}>
                  {scannedPalletId ? (
                    <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-white/20" />
                  )}
                  <span className={`text-xs font-medium font-mono ${scannedPalletId ? "text-amber-300" : "text-white/30"}`}>
                    Pallet: {scannedPalletId || "—"}
                  </span>
                </div>
                <div className={`flex items-center gap-2 backdrop-blur-xl rounded-full px-4 py-1.5 border ${scannedVehicleName ? "bg-amber-500/15 border-amber-500/25" : "bg-white/[0.04] border-white/[0.08]"}`}>
                  {scannedVehicleName ? (
                    <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-white/20" />
                  )}
                  <span className={`text-xs font-medium font-mono ${scannedVehicleName ? "text-amber-300" : "text-white/30"}`}>
                    Vehicle: {scannedVehicleName || "—"}
                  </span>
                </div>
              </div>
            )}
            {appMode === "receive" && !isProcessing && (
              <p className={`text-[11px] font-medium ${gpsCoords ? "text-emerald-400/60" : "text-amber-400/60"}`}>
                {gpsCoords
                  ? `GPS: ${gpsCoords.lat.toFixed(4)}, ${gpsCoords.lon.toFixed(4)}`
                  : gpsError || "Acquiring GPS..."}
              </p>
            )}
            {apiError && (
              <p className="text-red-400/80 text-xs font-medium mt-1">{apiError}</p>
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
              {isTranscribing ? (
                <div className="mt-2 w-28 h-1 rounded-full overflow-hidden bg-white/[0.08]">
                  <div className="h-full w-full animate-shimmer rounded-full" />
                </div>
              ) : modeStatus ? (
                <p className="mt-1.5 text-[11px] text-white/40 max-w-[200px] leading-tight pl-1">
                  {modeStatus}
                </p>
              ) : null}
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
        {/* Processing hint */}
        {isProcessing && (
          <div className="h-1 mx-auto max-w-[200px] rounded-full overflow-hidden mb-6 bg-white/[0.06]">
            <div className="h-full w-full animate-shimmer rounded-full" />
          </div>
        )}

        {/* Receive mode: GPS warning */}
        {viewState === "idle" && appMode === "receive" && !gpsCoords && (
          <p className="text-amber-400/70 text-xs text-center mb-4">
            {gpsError || "Waiting for GPS lock before scanning..."}
          </p>
        )}

        {/* Capture button */}
        <div className="flex items-center justify-center">
          <button
            type="button"
            onClick={viewState === "idle" ? handleCapture : undefined}
            disabled={
              !!cameraError ||
              isProcessing ||
              (appMode === "receive" && viewState === "idle" && !gpsCoords)
            }
            className="group relative w-[76px] h-[76px] rounded-full flex items-center justify-center disabled:opacity-30"
          >
            {/* Outer ring */}
            <div className="absolute inset-0 rounded-full border-[3px] border-white/80 transition-all duration-300" />
            {/* Inner shape */}
            <div
              className={`rounded-full transition-all duration-200 ${
                isProcessing
                  ? "w-14 h-14 bg-white/20"
                  : "w-[62px] h-[62px] bg-white group-active:scale-[0.92] group-active:bg-white/80"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Levenshtein edit distance between two strings. */
/** Send PCM to a fresh audio WebSocket and get transcription back. */
function doTranscribe(pcm16: Int16Array): Promise<string> {
  return new Promise((resolve) => {
    const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:8000";
    const ws = new WebSocket(`${proto}//${host}/ws/audio-stream`);
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
}

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
