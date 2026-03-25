import SwiftUI

struct ContentView: View {
    @StateObject private var glasses = GlassesSession()
    @StateObject private var appState = AppState()
    @StateObject private var pipeline = PipelineService()
    @StateObject private var audio = AudioService()
    @StateObject private var location = LocationService()

    private let serverIP = "https://kizzy-nonturbinated-nonpromiscuously.ngrok-free.dev"
    @State private var pollTask: Task<Void, Never>?
    @State private var debugLog: String = ""

    var body: some View {
        ZStack {
            rootNavigation

            // Debug overlay — shows connection status on screen
            VStack {
                Spacer()
                Text(debugLog)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.green)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.black.opacity(0.8))
                    .lineLimit(6)
            }
            .allowsHitTesting(false)
        }
        .preferredColorScheme(.dark)
        .onAppear {
            glasses.start()
            debugLog = "Starting... server=\(serverIP)"
            testAndStartWithDebug()
        }
        .modifier(ModeChangeHandler(appState: appState, location: location, serverIP: serverIP))
        .modifier(AudioSyncHandler(appState: appState, audio: audio))
        .modifier(LocationSyncHandler(appState: appState, location: location))
    }

    // MARK: - Root Navigation

    private var rootNavigation: some View {
        NavigationStack {
            Group {
                mainContent
            }
            .navigationDestination(for: String.self) { route in
                if route == "inventory" {
                    InventoryView()
                }
            }
        }
    }

    // MARK: - Main Content (view state router)

    @ViewBuilder
    private var mainContent: some View {
        switch appState.viewState {
        case .idle, .processing:
            ScanView(appState: appState, glasses: glasses, pipeline: pipeline)
        case .pendingApproval:
            ApprovalView(appState: appState)
        case .results:
            ResultsView(appState: appState)
        }
    }

    // MARK: - Connection Test + Services

    private func testAndStartWithDebug() {
        let base = ServerURL.http(serverIP)
        debugLog = "Testing \(base)/health ..."
        Task {
            let err = await APIClient.testConnection(serverIP: serverIP)
            if let err {
                debugLog = "FAILED: \(err)\nURL: \(base)/health"
            } else {
                debugLog = "Connected! Starting services..."
                startServices()
                debugLog = "Connected & running. Mode poll active."
            }
        }
    }

    private func startServices() {
        print("[App] Starting services with serverIP: \(serverIP)")
        audio.startListening(serverIP: serverIP)

        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                do {
                    let mode = try await APIClient.getMode(serverIP: serverIP)
                    if let appMode = AppMode(rawValue: mode) {
                        appState.appMode = appMode
                    }
                    debugLog = "Poll OK: mode=\(mode)"
                } catch {
                    debugLog = "Poll error: \(error.localizedDescription)"
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }

        if appState.appMode == .receive {
            location.startTracking()
        }
    }
}

// MARK: - Modifier: Mode Changes

private struct ModeChangeHandler: ViewModifier {
    @ObservedObject var appState: AppState
    @ObservedObject var location: LocationService
    let serverIP: String

    func body(content: Content) -> some View {
        content
            .onChange(of: appState.appMode) { _, newMode in
                if newMode == .receive {
                    location.startTracking()
                } else {
                    location.stopTracking()
                }
                Task {
                    try? await APIClient.setMode(serverIP: serverIP, mode: newMode)
                }
            }
    }
}

// MARK: - Modifier: Audio Sync

private struct AudioSyncHandler: ViewModifier {
    @ObservedObject var appState: AppState
    @ObservedObject var audio: AudioService

    func body(content: Content) -> some View {
        content
            .onChange(of: audio.detectedMode) { _, newMode in
                if let mode = newMode {
                    appState.appMode = mode
                    audio.detectedMode = nil
                }
            }
            .onChange(of: audio.isListening) { _, val in
                appState.isListening = val
            }
            .onChange(of: audio.isTranscribing) { _, val in
                appState.isTranscribing = val
            }
            .onChange(of: audio.modeStatus) { _, val in
                appState.modeStatus = val
            }
    }
}

// MARK: - Modifier: Location Sync

private struct LocationSyncHandler: ViewModifier {
    @ObservedObject var appState: AppState
    @ObservedObject var location: LocationService

    func body(content: Content) -> some View {
        content
            .onChange(of: location.coords) { _, coords in
                appState.gpsCoords = coords
            }
            .onChange(of: location.error) { _, val in
                appState.gpsError = val
            }
    }
}

#Preview {
    ContentView()
}
