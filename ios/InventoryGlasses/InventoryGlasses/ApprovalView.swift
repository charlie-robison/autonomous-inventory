import SwiftUI

/// Pending approval screen for load and receive modes.
/// Shows scanned data for user review before confirming the action.
struct ApprovalView: View {
    @ObservedObject var appState: AppState
    private let serverIP = "https://kizzy-nonturbinated-nonpromiscuously.ngrok-free.dev"

    private var isLoad: Bool { appState.appMode == .load }
    private var colors: ModeColors {
        ModeColors.forMode(appState.appMode)
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                header
                    .padding(.horizontal, 24)
                    .padding(.top, 56)
                    .padding(.bottom, 20)

                // Cards
                ScrollView {
                    VStack(spacing: 10) {
                        // Pallet ID (always)
                        infoCard(
                            label: "Pallet ID (QR)",
                            value: appState.scannedPalletId ?? "—",
                            delay: 0
                        )

                        // Vehicle (load only)
                        if isLoad {
                            infoCard(
                                label: "Vehicle Number",
                                value: appState.scannedVehicleName ?? "—",
                                delay: 0.08
                            )
                        }

                        // GPS (receive only)
                        if !isLoad, let coords = appState.gpsCoords {
                            infoCard(
                                label: "GPS Location",
                                value: String(format: "%.4f, %.4f", coords.latitude, coords.longitude),
                                delay: 0.08
                            )
                        }

                        // Error
                        if !appState.apiError.isEmpty {
                            RoundedRectangle(cornerRadius: 16)
                                .fill(Theme.errorBackground)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 16)
                                        .stroke(Theme.errorBorder, lineWidth: 1)
                                )
                                .overlay(
                                    Text(appState.apiError)
                                        .font(.system(size: 14))
                                        .foregroundStyle(Theme.errorText)
                                        .padding(20)
                                    , alignment: .leading
                                )
                                .frame(minHeight: 52)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                }

                Spacer()

                // Bottom buttons
                bottomButtons
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Circle()
                    .fill(colors.dotColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: colors.dotGlow, radius: 4)
                Text("Confirm \(isLoad ? "Load" : "Receive")")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2)
                    .textCase(.uppercase)
                    .foregroundStyle(colors.dotColor)
            }
            .padding(.bottom, 8)

            Text("Review & Approve")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(.white)
                .tracking(-0.3)

            Text("Verify the scanned data below before confirming.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Info Card

    private func infoCard(label: String, value: String, delay: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textMuted)
            Text(value)
                .font(.system(size: 14, weight: .regular, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Theme.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Theme.cardBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - Bottom Buttons

    private var bottomButtons: some View {
        HStack(spacing: 12) {
            // Confirm
            Button {
                handleApprove()
            } label: {
                Text("Confirm \(isLoad ? "Load" : "Receive")")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(colors.accentButton, in: RoundedRectangle(cornerRadius: 16))
                    .foregroundStyle(colors.accentButtonText)
            }

            // Cancel
            Button {
                appState.resetForNewScan()
            } label: {
                Text("Cancel")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(Color.white.opacity(0.07))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16)
                                    .stroke(Theme.glassBorderLight, lineWidth: 1)
                            )
                    )
                    .foregroundStyle(.white.opacity(0.8))
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 40)
    }

    // MARK: - Approve Handler

    private func handleApprove() {
        appState.viewState = .processing
        appState.apiError = ""
        Task {
            do {
                let result: [String: String]
                if isLoad {
                    result = try await APIClient.loadPallet(
                        serverIP: serverIP,
                        palletId: appState.scannedPalletId ?? "",
                        vehicleName: appState.scannedVehicleName ?? ""
                    )
                } else {
                    guard let coords = appState.gpsCoords else {
                        appState.apiError = "No GPS coordinates"
                        appState.viewState = .pendingApproval
                        return
                    }
                    result = try await APIClient.receivePallet(
                        serverIP: serverIP,
                        palletId: appState.scannedPalletId ?? "",
                        lat: coords.latitude,
                        lng: coords.longitude
                    )
                }

                if let error = result["error"] {
                    appState.apiError = error
                    appState.viewState = .pendingApproval
                } else {
                    appState.apiResult = result
                    appState.viewState = .results
                }
            } catch {
                appState.apiError = "Request failed: \(error.localizedDescription)"
                appState.viewState = .pendingApproval
            }
        }
    }
}
