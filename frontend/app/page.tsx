"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_URL = "http://localhost:8000";
const FRAME_INTERVAL_MS = 1500;

// ---------- Types ----------

interface Pallet {
  id: string;
  status: string;
  warehouse_fk: number | null;
  vehicle_fk: number | null;
  warehouse_name: string | null;
  vehicle_name: string | null;
  created_at: string;
  updated_at: string;
}

interface Item {
  id: number;
  shelf_label_text: string;
  product_name: string;
  facing_count: number;
  depth: number;
  price: number | null;
  confidence: number;
  shelf_position: string;
  updated?: boolean;
}

interface Activity {
  id: number;
  action: string;
  details: string;
  approved: number;
  created_at: string;
}

interface ReceiveResponse {
  pallet_id: string;
  action: string;
  status: string;
  warehouse_fk: string | null;
  vehicle_fk: null;
  geo: { lat: number; lng: number };
  island: string;
  ts: string;
}

interface LoadResponse {
  pallet_id: string;
  action: string;
  status: string;
  warehouse_fk: null;
  vehicle_fk: string | null;
  vehicle_num: string;
  ts: string;
}

type AppMode = "receive" | "load" | "count";
type Tab = "operate" | "activity" | "pallets";

const MODE_LABELS: Record<AppMode, string> = {
  receive: "Receive",
  load: "Load",
  count: "Count",
};

const MODE_COLORS: Record<AppMode, string> = {
  receive: "bg-purple-600",
  load: "bg-orange-600",
  count: "bg-cyan-600",
};

const STATUS_LABELS: Record<string, string> = {
  on_boat: "On Boat",
  at_port: "At Port",
  received: "Received",
  loaded: "Loaded",
};

const STATUS_COLORS: Record<string, string> = {
  on_boat: "bg-blue-600",
  at_port: "bg-yellow-600",
  received: "bg-purple-600",
  loaded: "bg-green-600",
};

// ---------- Component ----------

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const accumulatedItemsRef = useRef(new Map<string, Item>());

  // UI state
  const [tab, setTab] = useState<Tab>("operate");
  const [mode, setMode] = useState<AppMode | null>(null);
  const [error, setError] = useState("");

  // Camera / scanning
  const [cameraActive, setCameraActive] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [pendingFrames, setPendingFrames] = useState(0);

  // Voice
  const [listening, setListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");

  // Results
  const [scannedPallet, setScannedPallet] = useState<Pallet | null>(null);
  const [detectedVehicle, setDetectedVehicle] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [vlmResponse, setVlmResponse] = useState<string | null>(null);
  const [apiResponse, setApiResponse] = useState<
    ReceiveResponse | LoadResponse | null
  >(null);
  const [qrData, setQrData] = useState<{
    raw: string;
    resolved: string;
    is_url: boolean;
  } | null>(null);
  const [loadPhase, setLoadPhase] = useState<"scan_qr" | "find_vehicle">(
    "scan_qr"
  );

  // Lists
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [activityLog, setActivityLog] = useState<Activity[]>([]);

  // File upload
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [isFileVideo, setIsFileVideo] = useState(false);
  const [fileProcessing, setFileProcessing] = useState(false);
  const [fileProgress, setFileProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  // Geo
  const [geoPosition, setGeoPosition] = useState<{
    lat: number;
    lng: number;
  } | null>(null);

  // ==================== CAMERA ====================

  const startCamera = useCallback(async () => {
    setError("");
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);
    } catch {
      setError("Camera access denied. Please allow camera access.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setScanning(false);
    setProcessing(false);
  }, []);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? null;
  }, []);

  // ==================== SCANNING ====================

  const startScanning = useCallback(
    (activeMode: AppMode) => {
      setScanning(true);
      setFrameCount(0);
      setScannedPallet(null);
      setVlmResponse(null);
      setApiResponse(null);
      setQrData(null);
      setDetectedVehicle(null);
      setItems([]);
      setLoadPhase("scan_qr");
      accumulatedItemsRef.current = new Map();

      if (activeMode === "receive" || activeMode === "load") {
        // Stream frames to qreader backend — no VLM
        let busy = false;
        scanIntervalRef.current = setInterval(() => {
          if (busy) return;
          busy = true;

          const b64 = captureFrame();
          if (!b64) { busy = false; return; }

          setFrameCount((c) => c + 1);
          setProcessing(true);

          fetch(`${API_URL}/api/scan-qr`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: b64 }),
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((result) => {
              if (!result || !result.qr_codes?.length) return;

              const qr = result.qr_codes[0];
              setQrData(qr);
              const palletId = qr.resolved || qr.raw;

              if (activeMode === "receive") {
                if (scanIntervalRef.current) {
                  clearInterval(scanIntervalRef.current);
                  scanIntervalRef.current = null;
                }
                setScanning(false);
                receivePallet(palletId);
              } else {
                if (scanIntervalRef.current) {
                  clearInterval(scanIntervalRef.current);
                  scanIntervalRef.current = null;
                }
                setLoadPhase("find_vehicle");
                startVehicleScanning(palletId);
              }
            })
            .catch(() => {})
            .finally(() => {
              setProcessing(false);
              busy = false;
            });
        }, FRAME_INTERVAL_MS);
      } else {
        // Count mode: VLM via API
        scanIntervalRef.current = setInterval(() => {
          const b64 = captureFrame();
          if (!b64) return;

          setFrameCount((c) => c + 1);
          setPendingFrames((p) => p + 1);
          setProcessing(true);

          fetch(`${API_URL}/api/read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: b64 }),
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((result) => {
              if (!result) return;
              handleCountResult(result);
            })
            .catch(() => {})
            .finally(() => {
              setPendingFrames((p) => {
                const next = p - 1;
                if (next <= 0) setProcessing(false);
                return Math.max(0, next);
              });
            });
        }, FRAME_INTERVAL_MS);
      }
    },
    [captureFrame]
  );

  const startVehicleScanning = (palletId: string) => {
    // QR decoded — use VLM to find truck/vehicle number
    let busy = false;
    scanIntervalRef.current = setInterval(() => {
      if (busy) return;
      busy = true;

      const b64 = captureFrame();
      if (!b64) { busy = false; return; }

      setFrameCount((c) => c + 1);
      setProcessing(true);

      fetch(`${API_URL}/api/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: b64 }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((result) => {
          if (!result) return;
          if (result.raw_response) setVlmResponse(result.raw_response);

          const vehicles = result.vehicle_numbers || [];
          const valid = vehicles.find((v: { number: string }) => v.number);
          if (valid) {
            if (scanIntervalRef.current) {
              clearInterval(scanIntervalRef.current);
              scanIntervalRef.current = null;
            }
            setDetectedVehicle(valid.number);
            setScanning(false);
            loadPallet(palletId, valid.number);
          }
        })
        .catch(() => {})
        .finally(() => {
          setProcessing(false);
          busy = false;
        });
    }, FRAME_INTERVAL_MS);
  };

  const stopScanning = useCallback(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    setScanning(false);
    setProcessing(false);
    setPendingFrames(0);
  }, []);

  // ==================== MODE-SPECIFIC HANDLERS ====================

  const receivePallet = async (palletId: string) => {
    let lat = geoPosition?.lat ?? 21.4389;
    let lng = geoPosition?.lng ?? -158.0001;

    if (!geoPosition && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>(
          (resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              timeout: 5000,
            });
          }
        );
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        setGeoPosition({ lat, lng });
      } catch {
        // Use default Oahu coordinates
      }
    }

    try {
      const res = await fetch(`${API_URL}/api/pallets/${palletId}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      if (res.ok) {
        const data: ReceiveResponse = await res.json();
        setApiResponse(data);
        fetchPallets();
        fetchActivity();
      }
    } catch {
      setError("Failed to receive pallet");
    }
  };

  const loadPallet = async (palletId: string, vehicleName: string) => {
    try {
      const res = await fetch(`${API_URL}/api/pallets/${palletId}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_name: vehicleName }),
      });
      if (res.ok) {
        const data: LoadResponse = await res.json();
        setApiResponse(data);
        setDetectedVehicle(vehicleName);
        fetchPallets();
        fetchActivity();
      }
    } catch {
      setError("Failed to load pallet");
    }
  };

  const handleCountResult = (result: { items?: Item[] }) => {
    const newItems = result.items || [];
    for (const item of newItems) {
      const key = item.shelf_label_text;
      const existing = accumulatedItemsRef.current.get(key);
      // Only update if new detection has equal or higher confidence
      // Preserve user-set depth when updating
      if (!existing || item.confidence >= existing.confidence) {
        const depth = existing?.depth || item.depth || 1;
        accumulatedItemsRef.current.set(key, { ...item, depth });
      }
    }
    setItems(Array.from(accumulatedItemsRef.current.values()));
  };

  const updateDepth = async (itemId: number, depth: number) => {
    // Update local state immediately
    setItems((prev) =>
      prev.map((it) => (it.id === itemId ? { ...it, depth } : it))
    );
    // Also update the ref so future merges preserve it
    for (const [key, it] of accumulatedItemsRef.current) {
      if (it.id === itemId) {
        accumulatedItemsRef.current.set(key, { ...it, depth });
        break;
      }
    }
    // Persist to server
    try {
      await fetch(`${API_URL}/api/items/${itemId}/depth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depth }),
      });
    } catch {
      // ignore
    }
  };

  // ==================== FILE UPLOAD ====================

  const fileProcessingRef = useRef(false);

  const processImageFile = async (file: File, activeMode: AppMode) => {
    if (fileProcessingRef.current) return;
    fileProcessingRef.current = true;

    // Stop scanning FIRST
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    setScanning(false);
    setProcessing(false);

    setFilePreviewUrl(URL.createObjectURL(file));
    setIsFileVideo(false);
    setFileProcessing(true);
    setError("");
    setFrameCount(1);

    try {
      const base64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const comma = result.indexOf(",");
          if (comma >= 0) resolve(result.substring(comma + 1));
          else reject(new Error("Bad data URL"));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      const res = await fetch(`${API_URL}/api/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 }),
      });

      if (res.ok) {
        const result = await res.json();
        if (activeMode === "count") {
          handleCountResult(result);
        }
        // receive/load file upload not supported — use camera QR scanning
      }
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setFileProcessing(false);
      fileProcessingRef.current = false;
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const processVideoFile = async (file: File, activeMode: AppMode) => {
    if (fileProcessingRef.current) return;
    fileProcessingRef.current = true;

    // Stop any existing scanning
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    setScanning(false);
    setProcessing(false);

    const objectUrl = URL.createObjectURL(file);
    setFilePreviewUrl(objectUrl);
    setIsFileVideo(true);
    setError("");
    accumulatedItemsRef.current = new Map();
    setItems([]);
    setFrameCount(0);

    const video = offscreenVideoRef.current;
    if (!video) {
      fileProcessingRef.current = false;
      return;
    }

    try {
      video.src = objectUrl;
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error("Video load failed"));
      });

      // Play video at normal speed, scan frames on an interval — same as live camera
      video.currentTime = 0;
      await video.play();
      cancelRef.current = false;
      setScanning(true);

      const cleanup = () => {
        if (scanIntervalRef.current) {
          clearInterval(scanIntervalRef.current);
          scanIntervalRef.current = null;
        }
        setScanning(false);
        fileProcessingRef.current = false;
        video.pause();
        video.src = "";
        if (fileInputRef.current) fileInputRef.current.value = "";
      };

      // Stop when video ends
      video.onended = cleanup;

      scanIntervalRef.current = setInterval(() => {
        // Stop if cancelled or video finished
        if (cancelRef.current || video.ended) {
          cleanup();
          return;
        }

        const c = canvasRef.current;
        if (!c || video.videoWidth === 0) return;
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        const d = c.toDataURL("image/jpeg", 0.8);
        const comma = d.indexOf(",");
        const b64 = comma >= 0 ? d.substring(comma + 1) : null;
        if (!b64) return;

        setFrameCount((prev) => prev + 1);
        setPendingFrames((p) => p + 1);
        setProcessing(true);

        // Fire off API call without blocking the next crop
        fetch(`${API_URL}/api/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: b64 }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((result) => {
            if (!result) return;
            if (activeMode === "count") handleCountResult(result);
          })
          .catch(() => {})
          .finally(() => {
            setPendingFrames((p) => {
              const next = p - 1;
              if (next <= 0) setProcessing(false);
              return Math.max(0, next);
            });
          });
      }, FRAME_INTERVAL_MS);
    } catch (err) {
      setError(`Video failed: ${err instanceof Error ? err.message : "Unknown"}`);
      fileProcessingRef.current = false;
      video.src = "";
    }
  };

  // ==================== MODE SELECTION ====================

  const selectMode = useCallback(
    async (newMode: AppMode) => {
      // Set mode on server
      try {
        await fetch(`${API_URL}/api/mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: newMode }),
        });
      } catch {
        // continue anyway
      }

      setMode(newMode);
      setScannedPallet(null);
      setVlmResponse(null);
      setApiResponse(null);
      setQrData(null);
      setDetectedVehicle(null);
      setItems([]);
      setError("");
      setLoadPhase("scan_qr");
      accumulatedItemsRef.current = new Map();

      // Request geo for receive mode
      if (newMode === "receive" && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            setGeoPosition({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            }),
          () => {} // fail silently, will use default
        );
      }

      // Start camera and scanning
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          });
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraActive(true);

        // Small delay to let video initialize before scanning
        setTimeout(() => startScanning(newMode), 500);
      } catch {
        setError("Camera access denied. Please allow camera access.");
      }
    },
    [startScanning]
  );

  const changeMode = useCallback(() => {
    stopScanning();
    stopCamera();
    setMode(null);
    setScannedPallet(null);
    setVlmResponse(null);
    setApiResponse(null);
    setQrData(null);
    setDetectedVehicle(null);
    setItems([]);
    setFrameCount(0);
    setLoadPhase("scan_qr");
  }, [stopScanning, stopCamera]);

  const scanAnother = useCallback(() => {
    setScannedPallet(null);
    setVlmResponse(null);
    setApiResponse(null);
    setQrData(null);
    setDetectedVehicle(null);
    setFrameCount(0);
    setLoadPhase("scan_qr");
    if (mode) {
      startScanning(mode);
    }
  }, [mode, startScanning]);

  const testScan = useCallback(async () => {
    if (!mode || (mode !== "receive" && mode !== "load")) return;

    stopScanning();
    const testPalletId = `H${String(Math.floor(Math.random() * 999)).padStart(3, "0")}`;

    setQrData({ raw: testPalletId, resolved: testPalletId, is_url: false });
    setScanning(false);

    if (mode === "receive") {
      await receivePallet(testPalletId);
    } else {
      const testVehicle = `TRK-${String(Math.floor(Math.random() * 9999)).padStart(4, "0")}`;
      setDetectedVehicle(testVehicle);
      await loadPallet(testPalletId, testVehicle);
    }
  }, [mode, stopScanning]);

  // ==================== VOICE MODE SELECTION ====================

  const startVoiceSelection = useCallback(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Speech recognition not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const last = event.results[event.results.length - 1];
      const transcript = last[0].transcript.trim().toLowerCase();
      setVoiceTranscript(transcript);

      if (last.isFinal) {
        // Match to mode
        if (transcript.includes("receive")) {
          stopVoiceSelection();
          selectMode("receive");
        } else if (transcript.includes("load")) {
          stopVoiceSelection();
          selectMode("load");
        } else if (transcript.includes("count")) {
          stopVoiceSelection();
          selectMode("count");
        }
      }
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
      setVoiceTranscript("");
    };

    recognition.start();
    recognitionRef.current = recognition;
    setListening(true);
  }, [selectMode]);

  const stopVoiceSelection = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setListening(false);
    setVoiceTranscript("");
  }, []);

  // ==================== DATA FETCHING ====================

  const fetchPallets = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/pallets`);
      if (res.ok) setPallets(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/activity`);
      if (res.ok) setActivityLog(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  const approveActivity = async (id: number) => {
    try {
      await fetch(`${API_URL}/api/activity/${id}/approve`, { method: "POST" });
      fetchActivity();
    } catch {
      /* ignore */
    }
  };

  const dismissActivity = async (id: number) => {
    try {
      await fetch(`${API_URL}/api/activity/${id}/dismiss`, { method: "POST" });
      fetchActivity();
    } catch {
      /* ignore */
    }
  };

  // ==================== EFFECTS ====================

  useEffect(() => {
    if (tab === "pallets") fetchPallets();
    if (tab === "activity") fetchActivity();
  }, [tab, fetchPallets, fetchActivity]);

  useEffect(() => {
    return () => {
      if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream)
          .getTracks()
          .forEach((t) => t.stop());
      }
      if (recognitionRef.current) {
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      }
    };
  }, []);

  // ==================== RENDER ====================

  const parseDetails = (details: string) => {
    try {
      return JSON.parse(details);
    } catch {
      return {};
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <canvas ref={canvasRef} className="hidden" />
      <video ref={offscreenVideoRef} className="absolute -left-[9999px] w-0 h-0" muted playsInline preload="metadata" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file || !mode) return;
          if (file.type.startsWith("video/")) processVideoFile(file, mode);
          else processImageFile(file, mode);
        }}
        className="hidden"
      />

      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold">Loaders</h1>
        <div className="flex gap-1">
          {(["operate", "activity", "pallets"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded text-sm capitalize ${
                tab === t ? "bg-blue-600" : "bg-gray-800"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="bg-red-900/50 border-b border-red-800 px-4 py-2 text-red-200 text-sm">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* ==================== OPERATE TAB ==================== */}
      {tab === "operate" && (
        <div className="flex flex-col">
          {!mode ? (
            /* ---- Mode Selection ---- */
            <div className="p-6 space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold mb-2">Select Mode</h2>
                <p className="text-gray-400 text-sm">
                  Choose an operation or say the mode name
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 max-w-md mx-auto">
                {(["receive", "load", "count"] as AppMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => selectMode(m)}
                    className={`${MODE_COLORS[m]} py-6 rounded-xl text-xl font-bold hover:opacity-90 transition-opacity`}
                  >
                    {MODE_LABELS[m]}
                    <span className="block text-sm font-normal opacity-75 mt-1">
                      {m === "receive" &&
                        "Scan pallet QR at warehouse"}
                      {m === "load" &&
                        "Scan pallet QR + truck number"}
                      {m === "count" && "Count items on shelves"}
                    </span>
                  </button>
                ))}
              </div>

              {/* Voice selection */}
              <div className="text-center">
                {!listening ? (
                  <button
                    onClick={startVoiceSelection}
                    className="bg-gray-800 px-6 py-3 rounded-full text-sm hover:bg-gray-700 transition-colors"
                  >
                    <span className="mr-2">🎤</span>
                    Say &quot;Receive&quot;, &quot;Load&quot;, or
                    &quot;Count&quot;
                  </button>
                ) : (
                  <div className="space-y-2">
                    <button
                      onClick={stopVoiceSelection}
                      className="bg-red-600 px-6 py-3 rounded-full text-sm animate-pulse"
                    >
                      <span className="mr-2">🎤</span>
                      Listening...
                    </button>
                    {voiceTranscript && (
                      <p className="text-gray-400 text-sm italic">
                        &quot;{voiceTranscript}&quot;
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ---- Active Mode ---- */
            <div className="flex flex-col">
              {/* Camera feed / file preview */}
              <div className="relative bg-black aspect-video max-h-[50vh] flex items-center justify-center overflow-hidden">
                {/* Live camera */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-contain ${
                    cameraActive && !filePreviewUrl ? "" : "hidden"
                  }`}
                />

                {/* File preview */}
                {filePreviewUrl &&
                  (isFileVideo ? (
                    <video
                      src={filePreviewUrl}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <img
                      src={filePreviewUrl}
                      alt="Uploaded"
                      className="w-full h-full object-contain"
                    />
                  ))}

                {!cameraActive && !filePreviewUrl && (
                  <p className="text-gray-500">Starting camera...</p>
                )}

                {/* Mode badge */}
                <div
                  className={`absolute top-2 left-2 ${MODE_COLORS[mode]} px-2 py-1 rounded text-xs font-bold`}
                >
                  {MODE_LABELS[mode]} Mode
                </div>

                {/* Scanning indicator */}
                {scanning && (
                  <div className="absolute top-2 right-2 bg-red-600 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                    <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                    {mode === "count"
                      ? `Crop ${frameCount}`
                      : mode === "load" && loadPhase === "find_vehicle"
                        ? `Finding vehicle... (${frameCount})`
                        : `Scanning QR... (${frameCount})`}
                    {pendingFrames > 0 && (
                      <span className="text-red-200 ml-1">({pendingFrames} pending)</span>
                    )}
                  </div>
                )}

                {/* File processing indicator */}
                {fileProcessing && fileProgress && (
                  <div className="absolute top-2 right-2 bg-yellow-500 text-black px-2 py-1 rounded text-xs font-bold">
                    Frame {fileProgress.current}/{fileProgress.total}
                  </div>
                )}
                {fileProcessing && !fileProgress && (
                  <div className="absolute top-2 right-2 bg-yellow-500 text-black px-2 py-1 rounded text-xs font-bold animate-pulse">
                    Processing...
                  </div>
                )}

                {/* Found indicator */}
                {scannedPallet && !scanning && !fileProcessing && (
                  <div className="absolute top-2 right-2 bg-green-600 px-2 py-1 rounded text-xs font-bold">
                    FOUND
                  </div>
                )}
              </div>

              {/* File progress bar */}
              {fileProcessing && fileProgress && (
                <div className="px-3 py-2 bg-gray-900">
                  <div className="w-full bg-gray-800 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all"
                      style={{
                        width: `${(fileProgress.current / fileProgress.total) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Controls */}
              <div className="flex gap-2 p-3 bg-gray-900">
                {!scannedPallet && scanning ? (
                  <button
                    onClick={stopScanning}
                    className="flex-1 bg-yellow-600 py-3 rounded-lg font-semibold"
                  >
                    Pause
                  </button>
                ) : !scannedPallet && !scanning ? (
                  <button
                    onClick={() => startScanning(mode)}
                    className="flex-1 bg-green-600 py-3 rounded-lg font-semibold"
                  >
                    Resume Scanning
                  </button>
                ) : (
                  <button
                    onClick={scanAnother}
                    className="flex-1 bg-green-600 py-3 rounded-lg font-semibold"
                  >
                    Scan Another
                  </button>
                )}
                <button
                  onClick={changeMode}
                  className="bg-gray-700 px-4 py-3 rounded-lg font-semibold"
                >
                  Change Mode
                </button>
                {(mode === "receive" || mode === "load") && (
                  <button
                    onClick={testScan}
                    className="bg-blue-700 px-4 py-3 rounded-lg font-semibold text-sm"
                  >
                    Test
                  </button>
                )}
              </div>

              {/* File upload */}
              <div className="flex gap-2 px-3 pb-3 bg-gray-900">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={fileProcessing || (isFileVideo && scanning)}
                  className="flex-1 bg-gray-700 py-2 rounded-lg text-sm font-semibold hover:bg-gray-600 disabled:opacity-50"
                >
                  Upload Image / Video
                </button>
                {(fileProcessing || (isFileVideo && scanning)) && (
                  <button
                    onClick={() => {
                      cancelRef.current = true;
                    }}
                    className="bg-red-600 px-4 py-2 rounded-lg text-sm font-semibold"
                  >
                    Stop
                  </button>
                )}
                {filePreviewUrl && !fileProcessing && !scanning && (
                  <button
                    onClick={() => {
                      setFilePreviewUrl(null);
                      setIsFileVideo(false);
                    }}
                    className="bg-gray-600 px-4 py-2 rounded-lg text-sm font-semibold"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* ---- Mode-specific results ---- */}
              <div className="p-3 space-y-3">
                {/* QR Code Result */}
                {(mode === "receive" || mode === "load") && qrData && (
                  <div className="bg-gray-900 rounded-lg p-3 border border-green-700 space-y-2">
                    <p className="text-xs font-semibold text-gray-400">
                      QR Code Read
                    </p>
                    {qrData.is_url && (
                      <div>
                        <p className="text-xs text-gray-500">Raw QR:</p>
                        <p className="text-sm text-yellow-300 font-mono">{qrData.raw}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-gray-500">
                        {qrData.is_url ? "Resolved content:" : "Pallet ID:"}
                      </p>
                      <p className="text-lg font-bold text-green-300 font-mono whitespace-pre-wrap break-words">
                        {qrData.resolved}
                      </p>
                    </div>
                  </div>
                )}

                {/* API Response (structured JSON from server) */}
                {(mode === "receive" || mode === "load") && apiResponse && (
                  <div
                    className={`bg-gray-900 rounded-lg p-3 border ${
                      mode === "receive"
                        ? "border-green-700"
                        : "border-orange-700"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={
                          mode === "receive"
                            ? "text-green-400 text-lg"
                            : "text-orange-400 text-lg"
                        }
                      >
                        ✓
                      </span>
                      <p className="text-sm font-semibold text-gray-400">
                        {mode === "receive"
                          ? "Receive Response"
                          : "Load Response"}
                      </p>
                    </div>
                    <pre className="text-xs text-blue-300 whitespace-pre-wrap break-words font-mono bg-gray-950 rounded p-2">
                      {JSON.stringify(apiResponse, null, 2)}
                    </pre>
                  </div>
                )}

                {/* VLM Response (load vehicle detection) */}
                {mode === "load" && vlmResponse && loadPhase === "find_vehicle" && (
                  <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                    <p className="text-xs font-semibold text-gray-400 mb-1">
                      Gemini Vehicle Detection
                    </p>
                    <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words font-mono bg-gray-950 rounded p-2 max-h-48 overflow-y-auto">
                      {vlmResponse}
                    </pre>
                  </div>
                )}

                {/* Scanning hints */}
                {mode === "receive" && !apiResponse && scanning && (
                  <div className="text-center py-8 animate-pulse text-gray-400">
                    <p className="text-lg">Scanning for QR code...</p>
                    <p className="text-sm mt-2 text-gray-600">
                      Point camera at the QR code on the pallet
                    </p>
                  </div>
                )}
                {mode === "load" &&
                  !apiResponse &&
                  scanning &&
                  loadPhase === "scan_qr" && (
                    <div className="text-center py-8 animate-pulse text-gray-400">
                      <p className="text-lg">
                        Scanning for QR code...
                      </p>
                      <p className="text-sm mt-2 text-gray-600">
                        Point camera at the QR code on the pallet
                      </p>
                    </div>
                  )}
                {mode === "load" &&
                  !apiResponse &&
                  loadPhase === "find_vehicle" && (
                    <div className="text-center py-8 animate-pulse text-orange-400">
                      <p className="text-lg">
                        Step 2: Looking for truck number...
                      </p>
                      <p className="text-sm mt-2 text-gray-600">
                        Point camera at the vehicle number on the truck
                      </p>
                    </div>
                  )}

                {/* Count results */}
                {mode === "count" && (
                  <div className="space-y-2">
                    {items.length > 0 && (
                      <h3 className="text-sm font-semibold text-cyan-400">
                        Items Counted ({items.length})
                        {scanning && (
                          <span className="text-gray-500 font-normal ml-2">
                            live updating...
                          </span>
                        )}
                      </h3>
                    )}
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="bg-gray-900 rounded p-3 border border-gray-800"
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold truncate">
                              {item.product_name}
                            </p>
                            <p className="text-xs text-gray-400 mt-1 truncate">
                              {item.shelf_label_text}
                            </p>
                            <div className="flex gap-3 mt-1 text-xs text-gray-500">
                              {item.price != null && (
                                <span>${item.price.toFixed(2)}</span>
                              )}
                              {item.shelf_position && (
                                <span>{item.shelf_position}</span>
                              )}
                              <span
                                className={
                                  item.confidence >= 0.8
                                    ? "text-green-400"
                                    : item.confidence >= 0.5
                                      ? "text-yellow-400"
                                      : "text-red-400"
                                }
                              >
                                {(item.confidence * 100).toFixed(0)}% conf
                              </span>
                            </div>
                          </div>
                          <div className="text-right ml-3 flex flex-col items-end gap-1">
                            <div className="text-xs text-gray-500">
                              {item.facing_count} facing
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => updateDepth(item.id, Math.max(1, (item.depth || 1) - 1))}
                                className="w-6 h-6 rounded bg-gray-700 text-xs font-bold hover:bg-gray-600"
                              >
                                -
                              </button>
                              <span className="text-xs text-gray-400 w-14 text-center">
                                {item.depth || 1} deep
                              </span>
                              <button
                                onClick={() => updateDepth(item.id, (item.depth || 1) + 1)}
                                className="w-6 h-6 rounded bg-gray-700 text-xs font-bold hover:bg-gray-600"
                              >
                                +
                              </button>
                            </div>
                            <div className="text-2xl font-bold text-cyan-400">
                              {item.facing_count * (item.depth || 1)}
                            </div>
                            <div className="text-xs text-gray-500">total</div>
                          </div>
                        </div>
                      </div>
                    ))}
                    {!scanning && items.length === 0 && (
                      <p className="text-gray-500 text-center py-4">
                        No items detected yet. Scanning will begin
                        automatically.
                      </p>
                    )}
                  </div>
                )}

              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== ACTIVITY TAB ==================== */}
      {tab === "activity" && (
        <div className="p-3 space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold">Activity Log</h2>
            <button
              onClick={fetchActivity}
              className="text-sm bg-gray-800 px-3 py-1 rounded"
            >
              Refresh
            </button>
          </div>

          {activityLog.length === 0 ? (
            <p className="text-gray-500 text-center py-8">
              No activity yet.
            </p>
          ) : (
            activityLog.map((a) => {
              const details = parseDetails(a.details);
              return (
                <div
                  key={a.id}
                  className={`bg-gray-900 rounded p-3 border ${
                    a.approved === 1
                      ? "border-green-800"
                      : a.approved === -1
                        ? "border-red-800 opacity-50"
                        : "border-gray-800"
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">
                        {a.action === "pallet_received" && (
                          <span className="text-purple-400">
                            Pallet Received
                          </span>
                        )}
                        {a.action === "pallet_loaded" && (
                          <span className="text-orange-400">
                            Pallet Loaded
                          </span>
                        )}
                        {a.action === "items_counted" && (
                          <span className="text-cyan-400">Items Counted</span>
                        )}
                      </p>

                      {details.pallet_id && (
                        <p className="text-xs text-gray-400 mt-1">
                          Pallet:{" "}
                          <span className="font-mono">
                            {details.pallet_id}
                          </span>
                        </p>
                      )}
                      {details.warehouse && (
                        <p className="text-xs text-gray-400">
                          Warehouse: {details.warehouse}
                        </p>
                      )}
                      {details.vehicle && (
                        <p className="text-xs text-gray-400">
                          Vehicle: {details.vehicle}
                        </p>
                      )}
                      {details.item_count != null && (
                        <p className="text-xs text-gray-400">
                          {details.item_count} items counted
                        </p>
                      )}

                      <p className="text-xs text-gray-600 mt-1">
                        {a.created_at}
                      </p>
                    </div>

                    {a.approved === 0 && (
                      <div className="flex gap-1 ml-2">
                        <button
                          onClick={() => approveActivity(a.id)}
                          className="text-xs bg-green-700 px-2 py-1 rounded"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => dismissActivity(a.id)}
                          className="text-xs bg-red-700 px-2 py-1 rounded"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {a.approved === 1 && (
                      <span className="text-xs text-green-400 ml-2">
                        Approved
                      </span>
                    )}
                    {a.approved === -1 && (
                      <span className="text-xs text-red-400 ml-2">
                        Dismissed
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ==================== PALLETS TAB ==================== */}
      {tab === "pallets" && (
        <div className="p-3 space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold">All Pallets</h2>
            <button
              onClick={fetchPallets}
              className="text-sm bg-gray-800 px-3 py-1 rounded"
            >
              Refresh
            </button>
          </div>

          {pallets.length === 0 ? (
            <p className="text-gray-500 text-center py-8">
              No pallets tracked yet.
            </p>
          ) : (
            pallets.map((p) => (
              <div
                key={p.id}
                className="bg-gray-900 rounded p-3 border border-gray-800"
              >
                <div className="flex justify-between items-center mb-2">
                  <p className="font-mono font-bold text-lg">{p.id}</p>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                      STATUS_COLORS[p.status] || "bg-gray-600"
                    }`}
                  >
                    {STATUS_LABELS[p.status] || p.status}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-gray-500">Warehouse</span>
                    <p className="font-semibold">
                      {p.warehouse_name || "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-500">Vehicle</span>
                    <p className="font-semibold">
                      {p.vehicle_name || "—"}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-gray-600 mt-2">
                  Updated: {p.updated_at}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
