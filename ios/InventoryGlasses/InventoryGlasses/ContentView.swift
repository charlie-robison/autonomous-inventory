import SwiftUI

struct ContentView: View {
    @StateObject private var glasses = GlassesSession()
    @StateObject private var uploader = FrameUploader()

    @AppStorage("serverIP") private var serverIP = ""
    @State private var isStreaming = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                // Server configuration
                VStack(alignment: .leading, spacing: 8) {
                    Text("Server IP")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("e.g. 192.168.1.100", text: $serverIP)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.decimalPad)
                        .autocorrectionDisabled()
                }
                .padding(.horizontal)

                // Live preview
                if let image = glasses.latestImage {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxHeight: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal)
                } else {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(.systemGray6))
                        .frame(height: 200)
                        .overlay {
                            VStack(spacing: 8) {
                                Image(systemName: "eyeglasses")
                                    .font(.system(size: 40))
                                    .foregroundStyle(.secondary)
                                Text("No video feed")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal)
                }

                // Status indicators
                HStack(spacing: 24) {
                    StatusBadge(
                        label: "Glasses",
                        connected: glasses.isConnected
                    )
                    StatusBadge(
                        label: "Server",
                        connected: uploader.isConnected
                    )
                    VStack {
                        Text("\(uploader.framesSent)")
                            .font(.title2.monospacedDigit().bold())
                        Text("Frames")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                // Connect / Stop button
                Button {
                    if isStreaming {
                        stopStreaming()
                    } else {
                        startStreaming()
                    }
                } label: {
                    Text(isStreaming ? "Stop" : "Connect")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(isStreaming ? .red : .green)
                .disabled(serverIP.isEmpty && !isStreaming)
                .padding(.horizontal)

                // Error display
                if let error = glasses.error ?? uploader.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                Spacer()
            }
            .padding(.top)
            .navigationTitle("Inventory Glasses")
            .onChange(of: glasses.latestImage) { _, newImage in
                guard isStreaming, let image = newImage else { return }
                uploader.sendFrame(image)
            }
        }
    }

    private func startStreaming() {
        uploader.connect(serverIP: serverIP)
        glasses.start()
        isStreaming = true
    }

    private func stopStreaming() {
        glasses.stop()
        uploader.disconnect()
        isStreaming = false
    }
}

// MARK: - Status Badge

private struct StatusBadge: View {
    let label: String
    let connected: Bool

    var body: some View {
        VStack {
            Circle()
                .fill(connected ? Color.green : Color.gray.opacity(0.4))
                .frame(width: 12, height: 12)
                .shadow(color: connected ? .green.opacity(0.5) : .clear, radius: 4)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    ContentView()
}
