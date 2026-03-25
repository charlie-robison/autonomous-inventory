import SwiftUI

/// Pallet inventory dashboard matching the frontend's inventory page.
struct InventoryView: View {
    private let serverIP = "https://kizzy-nonturbinated-nonpromiscuously.ngrok-free.dev"
    @State private var pallets: [Pallet] = []
    @State private var loading = true
    @State private var error = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                header

                // Error
                if !error.isEmpty {
                    errorBanner
                }

                // Content
                if loading {
                    loadingView
                } else if pallets.isEmpty {
                    emptyView
                } else {
                    palletList
                }
            }
        }
        .navigationBarBackButtonHidden(true)
        .task {
            await pollPallets()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Inventory")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
                    .tracking(-0.3)
                Text("\(pallets.count) pallet\(pallets.count != 1 ? "s" : "")")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textMuted)
            }

            Spacer()

            Button {
                dismiss()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "camera")
                        .font(.system(size: 12))
                    Text("Scan")
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 14)
                .frame(height: 36)
                .background(
                    Capsule()
                        .fill(Theme.glassBackground)
                        .overlay(Capsule().stroke(Theme.glassBorder, lineWidth: 1))
                )
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 56)
        .padding(.bottom, 16)
    }

    // MARK: - Error Banner

    private var errorBanner: some View {
        HStack {
            Text(error)
                .font(.system(size: 14))
                .foregroundStyle(Theme.errorText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Theme.errorBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Theme.errorBorder, lineWidth: 1)
                )
        )
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack {
            Spacer()
            ProgressView()
                .tint(.white.opacity(0.3))
            Spacer()
        }
        .frame(height: 128)
    }

    // MARK: - Empty

    private var emptyView: some View {
        VStack(spacing: 4) {
            Spacer()
            Text("No pallets yet.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textMuted)
            Text("Scan a QR code to get started.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textFaint)
            Spacer()
        }
        .frame(height: 128)
    }

    // MARK: - Pallet List

    private var palletList: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Table header
                HStack {
                    Text("Pallet")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Status")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Updated")
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .font(.system(size: 11, weight: .semibold))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .padding(.bottom, 4)

                // Rows
                VStack(spacing: 8) {
                    ForEach(pallets) { pallet in
                        palletRow(pallet)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 32)
        }
    }

    private func palletRow(_ pallet: Pallet) -> some View {
        HStack {
            // Name
            Text(pallet.name ?? String(pallet.id.prefix(8)))
                .font(.system(size: 14, weight: .medium, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Status badge
            Text(pallet.status)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(statusColor(pallet.status).text)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(
                    Capsule()
                        .fill(statusColor(pallet.status).background)
                        .overlay(Capsule().stroke(statusColor(pallet.status).border, lineWidth: 1))
                )
                .frame(maxWidth: .infinity, alignment: .leading)

            // Updated
            Text(formatDate(pallet.updated_at))
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Theme.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Theme.cardBorder, lineWidth: 1)
                )
        )
    }

    private struct StatusStyle {
        let background: Color
        let border: Color
        let text: Color
    }

    private func statusColor(_ status: String) -> StatusStyle {
        switch status {
        case "received":
            return StatusStyle(
                background: Color(hex: 0x3B82F6, opacity: 0.20),
                border: Color(hex: 0x3B82F6, opacity: 0.30),
                text: Color(hex: 0x93C5FD)
            )
        case "loaded":
            return StatusStyle(
                background: Color(hex: 0xF59E0B, opacity: 0.20),
                border: Color(hex: 0xF59E0B, opacity: 0.30),
                text: Color(hex: 0xFCD34D)
            )
        default:
            return StatusStyle(
                background: Color.white.opacity(0.06),
                border: Color.white.opacity(0.08),
                text: Color.white.opacity(0.5)
            )
        }
    }

    private func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
            return iso
        }
        let display = DateFormatter()
        display.dateFormat = "MMM d, HH:mm"
        return display.string(from: date)
    }

    // MARK: - Polling

    private func pollPallets() async {
        while !Task.isCancelled {
            await fetchPallets()
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    private func fetchPallets() async {
        guard !serverIP.isEmpty else { return }
        do {
            let fetched = try await APIClient.getPallets(serverIP: serverIP)
            pallets = fetched
            error = ""
        } catch {
            self.error = "Failed to load pallets."
        }
        loading = false
    }
}
