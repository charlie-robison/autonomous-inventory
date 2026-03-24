"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Pallet {
  id: string;
  name: string | null;
  status: string;
  warehouse_fk: string | null;
  vehicle_fk: string | null;
  created_at: string;
  updated_at: string;
}

const API_BASE = typeof window !== "undefined"
  ? `${window.location.protocol}//${window.location.host}`
  : "";

const STATUS_STYLES: Record<string, string> = {
  received: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  loaded: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  on_port: "bg-white/[0.06] text-white/50 border-white/[0.08]",
  on_boat: "bg-white/[0.06] text-white/50 border-white/[0.08]",
};

export default function InventoryPage() {
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchPallets = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/pallets`);
      if (!res.ok) throw new Error("Failed to fetch pallets");
      const data = await res.json();
      setPallets(data);
    } catch {
      setError("Failed to load pallets.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPallets();
    const interval = setInterval(fetchPallets, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-14 pb-4">
        <div>
          <h1 className="text-white text-2xl font-bold tracking-tight">
            Inventory
          </h1>
          <p className="text-white/30 text-sm mt-0.5">
            {pallets.length} pallet{pallets.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/"
          className="h-9 px-3.5 flex items-center gap-1.5 rounded-full bg-white/[0.08] backdrop-blur-xl border border-white/[0.12] text-white/70 text-[13px] font-medium active:bg-white/[0.15]"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
          </svg>
          Scan
        </Link>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-5 mb-3 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto px-5 pb-8">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <svg className="w-5 h-5 text-white/30 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : pallets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32">
            <p className="text-white/30 text-sm">No pallets yet.</p>
            <p className="text-white/20 text-xs mt-1">Scan a QR code to get started.</p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="grid grid-cols-3 gap-3 px-4 py-2 mb-1">
              <p className="text-white/30 text-[11px] uppercase tracking-wider font-semibold">Pallet</p>
              <p className="text-white/30 text-[11px] uppercase tracking-wider font-semibold">Status</p>
              <p className="text-white/30 text-[11px] uppercase tracking-wider font-semibold text-right">Updated</p>
            </div>

            {/* Rows */}
            <div className="flex flex-col gap-2">
              {pallets.map((pallet) => (
                <div
                  key={pallet.id}
                  className="grid grid-cols-3 gap-3 items-center rounded-2xl px-4 py-3.5 bg-white/[0.03] border border-white/[0.06]"
                >
                  <p className="text-white/90 text-sm font-mono font-medium truncate">
                    {pallet.name || pallet.id.slice(0, 8)}
                  </p>
                  <div>
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider border ${STATUS_STYLES[pallet.status] || STATUS_STYLES.on_port}`}>
                      {pallet.status}
                    </span>
                  </div>
                  <p className="text-white/30 text-xs text-right">
                    {formatDate(pallet.updated_at)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
