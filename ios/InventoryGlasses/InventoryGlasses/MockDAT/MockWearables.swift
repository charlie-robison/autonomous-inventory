/// Local stand-in for the Meta DAT SDK (`WearablesDeviceAccessToolkit`).
///
/// This file lets the app compile and run using the iPhone's own camera
/// as a frame source, so you can test the full pipeline (frames → server
/// → VLM → frontend) without needing Meta glasses connected.
///
/// **To switch to the real DAT SDK:**
/// 1. Delete this MockDAT folder
/// 2. Add the real `WearablesDeviceAccessToolkit` SPM/framework dependency
/// 3. The rest of the app code (GlassesSession.swift, etc.) is written
///    against the real SDK API and should compile as-is.

import Foundation

// MARK: - Wearables (top-level setup)

enum Wearables {
    static func configure() {
        print("[MockDAT] Wearables.configure() — using iPhone camera fallback")
    }

    static func handleCallbackURL(_ url: URL) {
        print("[MockDAT] handleCallbackURL: \(url)")
    }
}
