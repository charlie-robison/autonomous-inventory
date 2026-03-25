import SwiftUI

/// Results screen shown after successful pipeline execution.
struct ResultsView: View {
    @ObservedObject var appState: AppState

    private var colors: ModeColors { ModeColors.forMode(appState.appMode) }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                header
                    .padding(.horizontal, 24)
                    .padding(.top, 56)
                    .padding(.bottom, 20)

                // Content
                ScrollView {
                    VStack(spacing: 10) {
                        switch appState.appMode {
                        case .count:
                            countResults
                        case .load:
                            loadResults
                        case .receive:
                            receiveResults
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

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Circle()
                    .fill(colors.dotColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: colors.dotGlow, radius: 4)
                Text(headerLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2)
                    .textCase(.uppercase)
                    .foregroundStyle(colors.dotColor)
            }
            .padding(.bottom, 8)

            if appState.appMode == .count {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(appState.totalItemCount)")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)
                    Text("items found")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.white.opacity(0.4))
                }
                Text("\(appState.results.count) types")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.top, 4)
            } else {
                Text(appState.appMode == .load ? "Load Complete" : "Receive Complete")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
                    .tracking(-0.3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerLabel: String {
        switch appState.appMode {
        case .count: return "Scan Complete"
        case .load: return "Pallet Loaded"
        case .receive: return "Pallet Received"
        }
    }

    // MARK: - Count Results

    private var countResults: some View {
        ForEach(Array(appState.results.enumerated()), id: \.element.id) { index, item in
            HStack {
                // Icon
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.white.opacity(0.06))
                    .frame(width: 36, height: 36)
                    .overlay {
                        Image(systemName: "shippingbox")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.white.opacity(0.4))
                    }

                Text(item.name)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)

                Spacer()

                Text("\(item.count)")
                    .font(.system(size: 20, weight: .bold, design: .default))
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }
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
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(
                .easeOut(duration: 0.4).delay(Double(index) * 0.08),
                value: appState.results.count
            )
        }
    }

    // MARK: - Load Results

    private var loadResults: some View {
        Group {
            resultCard(
                label: "Pallet",
                value: appState.apiResult?["name"] ?? appState.scannedPalletId ?? "—",
                delay: 0
            )
            resultCard(
                label: "Vehicle",
                value: appState.scannedVehicleName ?? "—",
                delay: 0.08
            )
            statusCard(
                text: (appState.apiResult?["status"] ?? "loaded").uppercased(),
                delay: 0.16
            )
        }
    }

    // MARK: - Receive Results

    private var receiveResults: some View {
        Group {
            resultCard(
                label: "Pallet",
                value: appState.apiResult?["name"] ?? appState.scannedPalletId ?? "—",
                delay: 0
            )
            if let warehouse = appState.apiResult?["warehouse_name"] {
                resultCard(
                    label: "Warehouse",
                    value: "HFA \(warehouse)",
                    delay: 0.08
                )
            }
            statusCard(
                text: (appState.apiResult?["status"] ?? "received").uppercased(),
                delay: 0.16
            )
        }
    }

    // MARK: - Card Components

    private func resultCard(label: String, value: String, delay: Double) -> some View {
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

    private func statusCard(text: String, delay: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Status")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(colors.dotColor)
            Text(text)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(colors.statusText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(colors.statusBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(colors.statusBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - Bottom Buttons

    private var bottomButtons: some View {
        HStack(spacing: 12) {
            // Scan Again
            Button {
                appState.resetForNewScan()
            } label: {
                Text("Scan Again")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(.white, in: RoundedRectangle(cornerRadius: 16))
                    .foregroundStyle(.black)
            }

            // Inventory
            NavigationLink(value: "inventory") {
                Text("Inventory")
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
}
