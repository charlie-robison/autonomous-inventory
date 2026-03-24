"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface StreamStatus {
  status: string;
  source_type: string;
  frames_processed: number;
  uptime: number | null;
  last_error: string | null;
  stream_url: string | null;
  capture_region: { x: number; y: number; width: number; height: number } | null;
}

interface WindowInfo {
  owner_name: string;
  window_name: string;
  window_id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

interface FrameResult {
  frame_number: number;
  timestamp: number;
  items_updated: { name: string; count: number; confidence_level?: number }[];
  type?: string;
}

interface RTMPInfo {
  rtmp_url: string;
  stream_key: string;
  hls_url: string;
  local_ip: string;
  rtmp_ready: boolean;
}

type Mode = "dat" | "rtmp" | "facebook-url" | "url" | "screen-capture" | "phone";

const API_BASE = typeof window !== "undefined"
  ? `${window.location.protocol}//${window.location.host}`
  : "";
const WS_BASE = typeof window !== "undefined"
  ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
  : "ws://localhost:8000";

export default function StreamPage() {
  const [mode, setMode] = useState<Mode>("dat");
  const [facebookUrl, setFacebookUrl] = useState("");
  const [streamUrl, setStreamUrl] = useState(
    "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
  );
  const [frameInterval, setFrameInterval] = useState("1.0");
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [results, setResults] = useState<FrameResult[]>([]);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedWindow, setSelectedWindow] = useState("");
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [rtmpInfo, setRtmpInfo] = useState<RTMPInfo | null>(null);
  const [rtmpStreamKey, setRtmpStreamKey] = useState("glasses");
  const [datWsUrl, setDatWsUrl] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/stream/status`);
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Poll status every 2 seconds
  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  // WebSocket connection for real-time results
  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/api/stream/ws/stream-results`);

    ws.onmessage = (event) => {
      const data: FrameResult = JSON.parse(event.data);
      if (data.type === "ping") return;
      setResults((prev) => [data, ...prev].slice(0, 100));
    };

    ws.onerror = () => {
      /* reconnect handled by cleanup/remount */
    };

    wsRef.current = ws;
    return () => {
      ws.close();
    };
  }, []);

  // Fetch RTMP server info when RTMP tab is active
  useEffect(() => {
    if (mode !== "rtmp") return;
    const fetchRtmpInfo = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/stream/rtmp-info`);
        if (res.ok) setRtmpInfo(await res.json());
      } catch {
        /* ignore */
      }
    };
    fetchRtmpInfo();
    const interval = setInterval(fetchRtmpInfo, 5000);
    return () => clearInterval(interval);
  }, [mode]);

  // Fetch DAT WebSocket URL when DAT tab is active
  useEffect(() => {
    if (mode !== "dat") return;
    const fetchDatInfo = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/stream/rtmp-info`);
        if (res.ok) {
          const data = await res.json();
          setDatWsUrl(`ws://${data.local_ip}:8000/api/stream/ws/dat-upload`);
        }
      } catch {
        /* ignore */
      }
    };
    fetchDatInfo();
  }, [mode]);

  const handleDetectWindows = async () => {
    setLoadingWindows(true);
    try {
      const res = await fetch(`${API_BASE}/api/stream/windows`);
      const data = await res.json();
      const wins: WindowInfo[] = data.windows || [];
      setWindows(wins);
      // Auto-select WhatsApp if found
      const whatsapp = wins.find(
        (w) => w.owner_name.toLowerCase() === "whatsapp"
      );
      if (whatsapp) {
        setSelectedWindow(whatsapp.owner_name);
      } else if (wins.length > 0) {
        setSelectedWindow(wins[0].owner_name);
      }
    } catch {
      setError("Failed to fetch window list");
    } finally {
      setLoadingWindows(false);
    }
  };

  const handleStart = async () => {
    setError("");
    setConnecting(true);

    try {
      let endpoint: string;
      let body: Record<string, unknown>;

      if (mode === "rtmp") {
        endpoint = "/api/stream/start-rtmp";
        body = {
          stream_key: rtmpStreamKey,
          frame_interval: parseFloat(frameInterval),
        };
      } else if (mode === "screen-capture") {
        endpoint = "/api/stream/start-screen-capture";
        const win = windows.find((w) => w.owner_name === selectedWindow);
        body = {
          window_id: win?.window_id,
          window_name: selectedWindow || undefined,
          frame_interval: parseFloat(frameInterval),
        };
      } else if (mode === "facebook-url") {
        endpoint = "/api/stream/start-facebook-url";
        body = {
          facebook_url: facebookUrl,
          frame_interval: parseFloat(frameInterval),
        };
      } else {
        endpoint = "/api/stream/start-url";
        body = {
          stream_url: streamUrl,
          frame_interval: parseFloat(frameInterval),
        };
      }

      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.status === "error") {
        setError(data.message);
      } else {
        setResults([]);
        await fetchStatus();
      }
    } catch (e) {
      setError(`Connection failed: ${e}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleStop = async () => {
    try {
      await fetch(`${API_BASE}/api/stream/stop`, { method: "POST" });
      await fetchStatus();
    } catch {
      setError("Failed to stop stream");
    }
  };

  const isRunning =
    status?.status === "running" ||
    status?.status === "connecting" ||
    status?.status === "reconnecting";

  const formatUptime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-14 pb-4">
        <div>
          <h1 className="text-white text-2xl font-bold tracking-tight">
            Live Stream
          </h1>
          <p className="text-white/30 text-sm mt-0.5">
            Meta Glasses &rarr; Video Feed &rarr; Inventory
          </p>
        </div>
        <Link
          href="/"
          className="h-9 px-3.5 flex items-center gap-1.5 rounded-full bg-white/[0.08] backdrop-blur-xl border border-white/[0.12] text-white/70 text-[13px] font-medium active:bg-white/[0.15]"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
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
          Scan
        </Link>
      </div>

      {/* Status panel */}
      <div className="mx-5 mb-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4">
        <div className="flex items-center gap-2 mb-3">
          <div
            className={`w-2 h-2 rounded-full ${
              status?.status === "running"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                : status?.status === "connecting" ||
                    status?.status === "reconnecting"
                  ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)] animate-pulse"
                  : "bg-white/20"
            }`}
          />
          <span className="text-white/60 text-sm font-medium capitalize">
            {status?.status || "idle"}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-white text-xl font-bold tabular-nums">
              {status?.frames_processed ?? 0}
            </p>
            <p className="text-white/30 text-[11px] uppercase tracking-wider">
              Frames
            </p>
          </div>
          <div>
            <p className="text-white text-xl font-bold tabular-nums">
              {status?.uptime ? formatUptime(status.uptime) : "--:--"}
            </p>
            <p className="text-white/30 text-[11px] uppercase tracking-wider">
              Uptime
            </p>
          </div>
          <div>
            <p className="text-white text-xl font-bold tabular-nums">
              {results.length}
            </p>
            <p className="text-white/30 text-[11px] uppercase tracking-wider">
              Results
            </p>
          </div>
        </div>
        {status?.last_error && (
          <p className="text-red-400/80 text-xs mt-3 truncate">
            {status.last_error}
          </p>
        )}
      </div>

      {/* Connection form */}
      {!isRunning && (
        <div className="mx-5 mb-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4">
          {/* Mode toggle */}
          <div className="flex rounded-xl bg-white/[0.04] p-1 mb-4 overflow-x-auto">
            <button
              type="button"
              onClick={() => setMode("dat")}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                mode === "dat"
                  ? "bg-white/[0.1] text-white"
                  : "text-white/40"
              }`}
            >
              Meta Glasses
            </button>
            <button
              type="button"
              onClick={() => setMode("rtmp")}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                mode === "rtmp"
                  ? "bg-white/[0.1] text-white"
                  : "text-white/40"
              }`}
            >
              RTMP
            </button>
            <button
              type="button"
              onClick={() => setMode("facebook-url")}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                mode === "facebook-url"
                  ? "bg-white/[0.1] text-white"
                  : "text-white/40"
              }`}
            >
              Facebook
            </button>
            <button
              type="button"
              onClick={() => setMode("url")}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "url"
                  ? "bg-white/[0.1] text-white"
                  : "text-white/40"
              }`}
            >
              URL
            </button>
            <button
              type="button"
              onClick={() => setMode("phone")}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "phone"
                  ? "bg-white/[0.1] text-white"
                  : "text-white/40"
              }`}
            >
              Phone
            </button>
            <button
              type="button"
              onClick={() => setMode("screen-capture")}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "screen-capture"
                  ? "bg-white/[0.1] text-white"
                  : "text-white/40"
              }`}
            >
              Screen
            </button>
          </div>

          {mode === "dat" ? (
            <div>
              <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-3 mb-3">
                <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">
                  WebSocket URL
                </p>
                <code className="text-emerald-400 text-sm break-all select-all">
                  {datWsUrl || "Loading..."}
                </code>
              </div>
              <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-3 mb-3">
                <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">
                  HTTP Fallback URL
                </p>
                <code className="text-emerald-400 text-sm break-all select-all">
                  {API_BASE}/api/stream/dat-upload
                </code>
              </div>

              <div className="mt-3 space-y-1.5">
                <p className="text-white/40 text-xs font-semibold">
                  DAT SDK Setup (iOS App)
                </p>
                <ol className="text-white/30 text-xs space-y-1 list-decimal list-inside">
                  <li>
                    Install the{" "}
                    <span className="text-white/50">InventoryGlasses</span> iOS
                    app via Xcode
                  </li>
                  <li>
                    Pair your Meta Ray-Ban glasses via the{" "}
                    <span className="text-white/50">Meta View</span> app
                  </li>
                  <li>
                    Open InventoryGlasses and enter this server&apos;s IP address
                  </li>
                  <li>
                    Tap <span className="text-white/50">Connect</span> to start
                    streaming frames
                  </li>
                </ol>
              </div>

              <p className="text-emerald-400/60 text-xs mt-3">
                Connection is initiated from the iOS app — no Start button
                needed.
              </p>
            </div>
          ) : mode === "rtmp" ? (
            <div>
              {/* RTMP server status */}
              <div className="flex items-center gap-2 mb-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    rtmpInfo?.rtmp_ready
                      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                      : "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]"
                  }`}
                />
                <span className="text-white/60 text-sm">
                  RTMP Server:{" "}
                  {rtmpInfo?.rtmp_ready ? (
                    <span className="text-emerald-400">Running</span>
                  ) : (
                    <span className="text-red-400">Not running</span>
                  )}
                </span>
              </div>

              {!rtmpInfo?.rtmp_ready && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 mb-3">
                  <p className="text-red-400/80 text-xs">
                    Start the RTMP server first:
                  </p>
                  <code className="text-red-300 text-sm mt-1 block select-all">
                    docker compose up -d
                  </code>
                </div>
              )}

              {/* Connection details */}
              <div className="space-y-2">
                <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-3">
                  <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">
                    RTMP Server URL
                  </p>
                  <code className="text-emerald-400 text-sm break-all select-all">
                    {rtmpInfo?.rtmp_url || `rtmp://loading...`}
                  </code>
                </div>
                <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-3">
                  <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">
                    Stream Key
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={rtmpStreamKey}
                      onChange={(e) => setRtmpStreamKey(e.target.value)}
                      className="flex-1 bg-transparent text-emerald-400 text-sm outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Setup instructions */}
              <div className="mt-3 space-y-1.5">
                <p className="text-white/40 text-xs font-semibold">
                  Meta Ray-Ban Gen 2 Setup
                </p>
                <ol className="text-white/30 text-xs space-y-1 list-decimal list-inside">
                  <li>
                    Run{" "}
                    <code className="text-white/50 bg-white/[0.06] px-1 rounded">
                      docker compose up -d
                    </code>{" "}
                    in the project root
                  </li>
                  <li>Open the Meta View app on your phone</li>
                  <li>
                    Go to Streaming settings &rarr;{" "}
                    <span className="text-white/50">Custom RTMP Server</span>
                  </li>
                  <li>
                    Enter the RTMP Server URL and Stream Key shown above
                  </li>
                  <li>
                    Ensure your phone is on the{" "}
                    <span className="text-white/50">same WiFi network</span> as
                    this computer
                  </li>
                  <li>
                    Double-press the capture button on your glasses to start
                    streaming
                  </li>
                  <li>
                    Click{" "}
                    <span className="text-white/50">Start Stream</span>{" "}
                    below once the feed is active
                  </li>
                </ol>
              </div>
            </div>
          ) : mode === "phone" ? (
            <div>
              <p className="text-white/50 text-sm leading-relaxed">
                Photos from your iPhone camera roll are sent automatically via
                an iOS Shortcut over local WiFi.
              </p>
              <div className="mt-3 rounded-xl bg-white/[0.04] border border-white/[0.08] p-3">
                <p className="text-white/30 text-[11px] uppercase tracking-wider mb-1">
                  Upload URL
                </p>
                <code className="text-emerald-400 text-sm break-all select-all">
                  {API_BASE}/api/stream/phone-upload
                </code>
              </div>
              <div className="mt-3 space-y-1.5">
                <p className="text-white/40 text-xs font-semibold">iOS Shortcut Setup</p>
                <ol className="text-white/30 text-xs space-y-1 list-decimal list-inside">
                  <li>Open the Shortcuts app on your iPhone</li>
                  <li>Create a new Automation &rarr; &ldquo;When photos are saved to an album&rdquo;</li>
                  <li>Add &ldquo;Get Latest Photos&rdquo; (limit 1)</li>
                  <li>Add &ldquo;Get Contents of URL&rdquo;:
                    <span className="text-white/50"> POST</span> to the URL above,
                    form field <span className="text-white/50">file</span> = the photo
                  </li>
                  <li>Run immediately, no confirmation needed</li>
                </ol>
              </div>
              <p className="text-emerald-400/60 text-xs mt-3">
                Endpoint is always active — no start button needed.
              </p>
            </div>
          ) : mode === "facebook-url" ? (
            <div>
              <input
                type="text"
                placeholder="https://www.facebook.com/yourpage/videos/123456"
                value={facebookUrl}
                onChange={(e) => setFacebookUrl(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-white text-sm placeholder:text-white/20 outline-none focus:border-white/20"
              />
              <p className="text-white/20 text-xs mt-2">
                Paste your Facebook Live video URL — resolved via yt-dlp
              </p>
            </div>
          ) : mode === "url" ? (
            <input
              type="text"
              placeholder="HLS Stream URL (.m3u8)"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-white text-sm placeholder:text-white/20 outline-none focus:border-white/20"
            />
          ) : (
            <div>
              <button
                type="button"
                onClick={handleDetectWindows}
                disabled={loadingWindows}
                className="w-full h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] text-white/70 text-sm font-medium active:bg-white/[0.1] transition-colors disabled:opacity-40"
              >
                {loadingWindows ? "Detecting..." : "Detect Windows"}
              </button>
              {windows.length > 0 && (
                <select
                  value={selectedWindow}
                  onChange={(e) => setSelectedWindow(e.target.value)}
                  className="w-full mt-3 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-white/20 appearance-none"
                >
                  {windows.map((w) => (
                    <option
                      key={w.window_id}
                      value={w.owner_name}
                      className="bg-[#1a1a2e] text-white"
                    >
                      {w.owner_name}
                      {w.window_name ? ` — ${w.window_name}` : ""}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-white/20 text-xs mt-2">
                Select a window to capture (e.g. WhatsApp video call). Requires
                macOS Screen Recording permission.
              </p>
            </div>
          )}

          {mode !== "phone" && mode !== "dat" && (
            <div className="flex items-center gap-3 mt-3">
              <label className="text-white/30 text-xs font-medium uppercase tracking-wider whitespace-nowrap">
                Frame Interval (s)
              </label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                value={frameInterval}
                onChange={(e) => setFrameInterval(e.target.value)}
                className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-white text-sm text-center outline-none focus:border-white/20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {error && (
            <p className="text-red-400 text-sm mt-3">{error}</p>
          )}

          {mode !== "phone" && mode !== "dat" && (
            <button
              type="button"
              onClick={handleStart}
              disabled={
                connecting ||
                (mode === "rtmp"
                  ? !rtmpInfo?.rtmp_ready
                  : mode === "facebook-url"
                    ? !facebookUrl
                    : mode === "url"
                      ? !streamUrl
                      : false)
              }
              className="w-full mt-4 h-12 rounded-xl bg-emerald-500 text-white font-semibold text-sm active:scale-[0.98] transition-all disabled:opacity-30"
            >
              {connecting ? "Connecting..." : "Start Stream"}
            </button>
          )}
        </div>
      )}

      {/* Stop button */}
      {isRunning && (
        <div className="mx-5 mb-4">
          <button
            type="button"
            onClick={handleStop}
            className="w-full h-12 rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 font-semibold text-sm active:scale-[0.98] transition-all"
          >
            Stop Stream
          </button>
        </div>
      )}

      {/* Results feed */}
      <div className="flex-1 overflow-auto px-5 pb-8">
        <h2 className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-3">
          Live Results
        </h2>
        {results.length === 0 ? (
          <p className="text-white/20 text-sm">
            No results yet. Start a stream to see real-time detections.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {results.map((result, i) => (
              <div
                key={`${result.frame_number}-${i}`}
                className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 animate-fade-up"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white/30 text-xs font-mono">
                    Frame #{result.frame_number}
                  </span>
                  <span className="text-white/20 text-xs">
                    {new Date(result.timestamp * 1000).toLocaleTimeString()}
                  </span>
                </div>
                {result.items_updated.length === 0 ? (
                  <p className="text-white/30 text-sm">No items detected</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {result.items_updated.map((item, j) => (
                      <span
                        key={j}
                        className="inline-flex items-center gap-1.5 bg-white/[0.06] rounded-lg px-2.5 py-1 text-sm"
                      >
                        <span className="text-white/80">{item.name}</span>
                        <span className="text-white/40 font-bold">
                          x{item.count}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
