import Foundation
import SwiftUI

// MARK: - Enums

enum AppMode: String, CaseIterable {
    case count, receive, load
}

enum ViewState: Equatable {
    case idle
    case processing
    case pendingApproval
    case results
}

// MARK: - Models

struct ScanResult: Identifiable {
    let id = UUID()
    let name: String
    let count: Int
}

struct Pallet: Identifiable, Codable {
    let id: String
    let name: String?
    let status: String
    let warehouse_fk: String?
    let vehicle_fk: String?
    let created_at: String
    let updated_at: String
}

/// Simple Equatable coordinate type so `.onChange` works.
struct Coordinate: Equatable {
    let latitude: Double
    let longitude: Double
}

// MARK: - App State

@MainActor
final class AppState: ObservableObject {
    @Published var appMode: AppMode = .count
    @Published var viewState: ViewState = .idle

    // Count results
    @Published var results: [ScanResult] = []

    // Load / Receive scan data
    @Published var scannedPalletId: String?
    @Published var scannedVehicleName: String?

    // GPS (receive mode)
    @Published var gpsCoords: Coordinate?
    @Published var gpsError: String = ""

    // Audio / voice
    @Published var isListening: Bool = false
    @Published var isTranscribing: Bool = false
    @Published var modeStatus: String = ""

    // API response
    @Published var apiResult: [String: String]?
    @Published var apiError: String = ""

    var totalItemCount: Int {
        results.reduce(0) { $0 + $1.count }
    }

    var instruction: String {
        switch appMode {
        case .count:
            return "Point camera at inventory items"
        case .receive:
            return "Scan the QR code on the pallet"
        case .load:
            if scannedPalletId != nil && scannedVehicleName == nil {
                return "Now scan the vehicle number"
            }
            if scannedPalletId == nil && scannedVehicleName != nil {
                return "Now scan the QR code on the pallet"
            }
            return "Scan the pallet QR code or vehicle number"
        }
    }

    func resetForNewScan() {
        results = []
        scannedPalletId = nil
        scannedVehicleName = nil
        apiResult = nil
        apiError = ""
        viewState = .idle
    }
}
