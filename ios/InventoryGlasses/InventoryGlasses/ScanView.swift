import AVFoundation
import PhotosUI
import SwiftUI

/// Main scanning interface — covers idle and processing view states.
/// Matches the frontend's camera/recording/processing render path.
struct ScanView: View {
    @ObservedObject var appState: AppState
    @ObservedObject var glasses: GlassesSession
    @ObservedObject var pipeline: PipelineService
    private let serverIP = "https://kizzy-nonturbinated-nonpromiscuously.ngrok-free.dev"

    @State private var scanLinePosition: CGFloat = 0.15
    @State private var bracketOpacity: Double = 0.6
    @State private var shimmerOffset: CGFloat = -200
    @State private var showVideoPicker = false
    @State private var selectedVideoItem: PhotosPickerItem?
    @State private var videoProcessingStatus: String = ""

    private var isProcessing: Bool { appState.viewState == .processing }
    private var colors: ModeColors { ModeColors.forMode(appState.appMode) }

    var body: some View {
        ZStack {
            // Full-screen camera feed
            cameraLayer

            // Vignette overlay
            vignetteOverlay

            // Top / bottom gradients
            gradientOverlays

            // Viewfinder with corner brackets + scan line
            viewfinder

            // Status / instruction area
            statusOverlay

            // Mode badge + nav links (idle only)
            if !isProcessing {
                topOverlays
            }

            // Bottom controls
            VStack {
                Spacer()
                bottomControls
            }

            // Meta glasses registration (if needed)
            #if !targetEnvironment(simulator)
            if !glasses.isRegistered {
                registrationOverlay
            }
            #endif
        }
        .ignoresSafeArea()
        .background(Color.black)
        .onAppear {
            startAnimations()
        }
    }

    // MARK: - Camera Layer

    @ViewBuilder
    private var cameraLayer: some View {
        if let image = glasses.latestImage {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
        } else {
            // Placeholder
            Color.black
                .overlay {
                    VStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 16)
                            .fill(Color.white.opacity(0.04))
                            .frame(width: 80, height: 80)
                            .overlay {
                                Image(systemName: "camera")
                                    .font(.system(size: 36))
                                    .foregroundStyle(Color.white.opacity(0.3))
                            }
                        Text("Camera Access Required")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(Color.white.opacity(0.8))
                        Text(glasses.statusMessage.isEmpty
                             ? (glasses.error ?? "No video feed")
                             : glasses.statusMessage)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textMuted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 260)
                    }
                }
        }
    }

    // MARK: - Vignette

    private var vignetteOverlay: some View {
        RadialGradient(
            colors: [.clear, .black.opacity(0.55)],
            center: .center,
            startRadius: UIScreen.main.bounds.width * 0.2,
            endRadius: UIScreen.main.bounds.width * 0.5
        )
        .allowsHitTesting(false)
    }

    // MARK: - Gradient Overlays

    private var gradientOverlays: some View {
        ZStack {
            VStack {
                LinearGradient(
                    colors: [.black.opacity(0.7), .black.opacity(0.3), .clear],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: 112)
                Spacer()
            }
            VStack {
                Spacer()
                LinearGradient(
                    colors: [.black.opacity(0.5), .clear],
                    startPoint: .bottom, endPoint: .top
                )
                .frame(height: 112)
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: - Viewfinder

    private var viewfinder: some View {
        GeometryReader { geo in
            let size: CGFloat = 288
            let bracketSize: CGFloat = 48
            let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2 - 20)
            let origin = CGPoint(x: center.x - size / 2, y: center.y - size / 2)

            ZStack {
                // Corner brackets
                ForEach(0..<4, id: \.self) { i in
                    CornerBracket(
                        index: i,
                        size: bracketSize,
                        color: isProcessing ? Theme.red400 : .white.opacity(0.6),
                        lineWidth: 2
                    )
                    .opacity(isProcessing ? bracketOpacity : 1)
                    .position(bracketPosition(index: i, origin: origin, viewSize: size, bracketSize: bracketSize))
                }

                // Scanning line (processing only)
                if isProcessing {
                    let lineY = origin.y + size * scanLinePosition
                    Rectangle()
                        .fill(
                            LinearGradient(
                                colors: [.clear, Theme.red400, .clear],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                        .frame(width: size - 24, height: 2)
                        .shadow(color: Theme.red400.opacity(0.5), radius: 6)
                        .position(x: center.x, y: lineY)
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func bracketPosition(index: Int, origin: CGPoint, viewSize: CGFloat, bracketSize: CGFloat) -> CGPoint {
        let half = bracketSize / 2
        switch index {
        case 0: return CGPoint(x: origin.x + half, y: origin.y + half) // top-left
        case 1: return CGPoint(x: origin.x + viewSize - half, y: origin.y + half) // top-right
        case 2: return CGPoint(x: origin.x + half, y: origin.y + viewSize - half) // bottom-left
        case 3: return CGPoint(x: origin.x + viewSize - half, y: origin.y + viewSize - half) // bottom-right
        default: return .zero
        }
    }

    // MARK: - Status Overlay

    private var statusOverlay: some View {
        GeometryReader { geo in
            let topY = geo.size.height / 2 - 144 - 20
            VStack(spacing: 8) {
                if isProcessing {
                    // Spinner + "Scanning..."
                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(.white.opacity(0.6))
                            .scaleEffect(0.8)
                        Text("Scanning...")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.white.opacity(0.6))
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.1), lineWidth: 1))
                } else {
                    Text(appState.instruction)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.textTertiary)
                        .tracking(0.3)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                // Load mode: detection badges
                if appState.appMode == .load && !isProcessing {
                    loadBadges
                }

                // Receive mode: GPS status
                if appState.appMode == .receive && !isProcessing {
                    if let coords = appState.gpsCoords {
                        Text("GPS: \(coords.latitude, specifier: "%.4f"), \(coords.longitude, specifier: "%.4f")")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color(hex: 0x34D399, opacity: 0.6))
                    } else {
                        Text(appState.gpsError.isEmpty ? "Acquiring GPS..." : appState.gpsError)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color(hex: 0xFBBF24, opacity: 0.6))
                    }
                }

                // API error
                if !appState.apiError.isEmpty {
                    Text(appState.apiError)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.red400.opacity(0.8))
                }
            }
            .position(x: geo.size.width / 2, y: topY)
        }
        .allowsHitTesting(false)
    }

    // MARK: - Load Mode Badges

    private var loadBadges: some View {
        VStack(spacing: 6) {
            detectionBadge(
                label: "Pallet",
                value: appState.scannedPalletId,
                detected: appState.scannedPalletId != nil
            )
            detectionBadge(
                label: "Vehicle",
                value: appState.scannedVehicleName,
                detected: appState.scannedVehicleName != nil
            )
        }
        .padding(.top, 4)
    }

    private func detectionBadge(label: String, value: String?, detected: Bool) -> some View {
        HStack(spacing: 8) {
            if detected {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(colors.dotColor)
            } else {
                Circle()
                    .stroke(Color.white.opacity(0.2), lineWidth: 1)
                    .frame(width: 14, height: 14)
            }
            Text("\(label): \(value ?? "—")")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(detected ? colors.badgeText : Theme.textMuted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(
            Capsule()
                .fill(detected ? colors.badgeBackground : Color.white.opacity(0.04))
                .overlay(Capsule().stroke(detected ? colors.badgeBorder : Color.white.opacity(0.08), lineWidth: 1))
        )
    }

    // MARK: - Top Overlays (Mode Badge + Nav)

    private var topOverlays: some View {
        VStack {
            HStack(alignment: .top) {
                // Mode badge + status
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(colors.dotColor)
                            .frame(width: 8, height: 8)
                            .shadow(color: colors.dotGlow, radius: 4)
                        Text(appState.appMode.rawValue.uppercased())
                            .font(.system(size: 13, weight: .semibold))
                            .tracking(2)
                            .foregroundStyle(colors.badgeText)
                        if appState.isListening {
                            Image(systemName: "mic.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(colors.badgeText.opacity(0.6))
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(
                        Capsule()
                            .fill(colors.badgeBackground)
                            .overlay(Capsule().stroke(colors.badgeBorder, lineWidth: 1))
                    )

                    // Transcription shimmer or status text
                    if appState.isTranscribing {
                        ShimmerBar()
                            .frame(width: 112, height: 4)
                            .padding(.leading, 4)
                    } else if !appState.modeStatus.isEmpty {
                        Text(appState.modeStatus)
                            .font(.system(size: 11))
                            .foregroundStyle(Color.white.opacity(0.4))
                            .lineLimit(2)
                            .frame(maxWidth: 200, alignment: .leading)
                            .padding(.leading, 4)
                    }
                }

                Spacer()

                // Nav links
                HStack(spacing: 8) {
                    NavigationLink(value: "inventory") {
                        HStack(spacing: 6) {
                            Image(systemName: "tablecells")
                                .font(.system(size: 12))
                            Text("Items")
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
            }
            .padding(.horizontal, 16)
            .padding(.top, 48) // safe area top

            Spacer()
        }
    }

    // MARK: - Bottom Controls

    private var bottomControls: some View {
        VStack(spacing: 0) {
            // Processing shimmer bar
            if isProcessing {
                ShimmerBar()
                    .frame(maxWidth: 200, maxHeight: 4)
                    .padding(.bottom, 12)
            }

            // Video processing status
            if !videoProcessingStatus.isEmpty {
                Text(videoProcessingStatus)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color(hex: 0x34D399, opacity: 0.8))
                    .padding(.bottom, 12)
            }

            // GPS warning for receive mode
            if appState.viewState == .idle && appState.appMode == .receive && appState.gpsCoords == nil {
                Text(appState.gpsError.isEmpty ? "Waiting for GPS lock before scanning..." : appState.gpsError)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(hex: 0xFBBF24, opacity: 0.7))
                    .padding(.bottom, 16)
            }

            // Buttons row
            HStack(spacing: 24) {
                // Upload video button (count mode only)
                if appState.appMode == .count && !isProcessing {
                    PhotosPicker(
                        selection: $selectedVideoItem,
                        matching: .videos
                    ) {
                        VStack(spacing: 4) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 20))
                                .foregroundStyle(.white.opacity(0.7))
                            Text("Upload")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(.white.opacity(0.5))
                        }
                        .frame(width: 52, height: 52)
                    }
                    .onChange(of: selectedVideoItem) { _, newItem in
                        if let item = newItem {
                            handleVideoUpload(item: item)
                            selectedVideoItem = nil
                        }
                    }
                }

                // Capture button
                Button {
                    if appState.viewState == .idle {
                        handleCapture()
                    }
                } label: {
                    ZStack {
                        Circle()
                            .stroke(Color.white.opacity(0.8), lineWidth: 3)
                            .frame(width: 76, height: 76)
                        Circle()
                            .fill(isProcessing ? Color.white.opacity(0.2) : Color.white)
                            .frame(width: isProcessing ? 56 : 62, height: isProcessing ? 56 : 62)
                            .animation(.easeInOut(duration: 0.2), value: isProcessing)
                    }
                }
                .disabled(
                    glasses.latestImage == nil
                    || isProcessing
                    || (appState.appMode == .receive && appState.viewState == .idle && appState.gpsCoords == nil)
                )
                .opacity(
                    (glasses.latestImage == nil
                     || (appState.appMode == .receive && appState.viewState == .idle && appState.gpsCoords == nil))
                    ? 0.3 : 1
                )

                // Spacer to balance layout when upload button is shown
                if appState.appMode == .count && !isProcessing {
                    Color.clear.frame(width: 52, height: 52)
                }
            }
        }
        .padding(.bottom, 40)
        .background(
            LinearGradient(
                colors: [.black, .black.opacity(0.95), .black.opacity(0.8)],
                startPoint: .bottom, endPoint: .top
            )
            .frame(height: 180)
            .offset(y: 40),
            alignment: .bottom
        )
    }

    // MARK: - Registration Overlay

    private var registrationOverlay: some View {
        VStack {
            Spacer()
            Button {
                glasses.register()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "link.badge.plus")
                    Text("Connect Meta Glasses")
                }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color(hex: 0x3B82F6), in: RoundedRectangle(cornerRadius: 16))
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 120)
        }
    }

    // MARK: - Capture Handlers

    private func handleCapture() {
        switch appState.appMode {
        case .count: handleCountCapture()
        case .receive: handleReceiveCapture()
        case .load: handleLoadCapture()
        }
    }

    private func handleCountCapture() {
        guard let image = glasses.latestImage else { return }
        appState.viewState = .processing
        Task {
            do {
                let items = try await pipeline.sendToCount(image: image, serverIP: serverIP)
                appState.results = items
                appState.viewState = .results
            } catch {
                appState.apiError = error.localizedDescription
                appState.viewState = .idle
            }
        }
    }

    private func handleReceiveCapture() {
        guard let image = glasses.latestImage else { return }
        guard appState.gpsCoords != nil else {
            appState.gpsError = "Waiting for GPS coordinates..."
            return
        }
        appState.viewState = .processing
        Task {
            do {
                let palletId = try await pipeline.sendToScanQR(image: image, serverIP: serverIP)
                appState.scannedPalletId = palletId
                appState.viewState = .pendingApproval
            } catch {
                appState.apiError = error.localizedDescription
                appState.viewState = .idle
            }
        }
    }

    private func handleLoadCapture() {
        guard let image = glasses.latestImage else { return }
        appState.viewState = .processing
        appState.apiError = ""
        Task {
            // Fire both in parallel
            async let qrTask: String? = {
                try? await pipeline.sendToScanQR(image: image, serverIP: serverIP)
            }()
            async let vehicleTask: String? = {
                try? await pipeline.sendToScanVehicle(image: image, serverIP: serverIP)
            }()

            let qrResult = await qrTask
            let vehicleResult = await vehicleTask

            if let qr = qrResult { appState.scannedPalletId = qr }
            if let vehicle = vehicleResult { appState.scannedVehicleName = vehicle }

            // If both found, go to approval
            if appState.scannedPalletId != nil && appState.scannedVehicleName != nil {
                appState.viewState = .pendingApproval
            } else {
                appState.viewState = .idle
            }
        }
    }

    // MARK: - Video Upload

    private func handleVideoUpload(item: PhotosPickerItem) {
        appState.viewState = .processing
        appState.apiError = ""
        videoProcessingStatus = "Loading video..."

        Task {
            do {
                guard let movie = try await item.loadTransferable(type: VideoTransferable.self) else {
                    appState.apiError = "Could not load video"
                    appState.viewState = .idle
                    videoProcessingStatus = ""
                    return
                }

                let frames = try await extractFrames(from: movie.url, maxFrames: 10, intervalSeconds: 2.0)
                videoProcessingStatus = "Extracted \(frames.count) frames"

                var allResults: [ScanResult] = []
                for (i, frame) in frames.enumerated() {
                    videoProcessingStatus = "Processing frame \(i + 1)/\(frames.count)..."
                    do {
                        let items = try await pipeline.sendToCount(image: frame, serverIP: serverIP)
                        for item in items {
                            if let existing = allResults.firstIndex(where: { $0.name == item.name }) {
                                let old = allResults[existing]
                                allResults[existing] = ScanResult(name: old.name, count: max(old.count, item.count))
                            } else {
                                allResults.append(item)
                            }
                        }
                    } catch {
                        // Skip failed frames, continue with the rest
                        print("[Video] Frame \(i + 1) failed: \(error)")
                    }
                }

                appState.results = allResults
                videoProcessingStatus = ""
                appState.viewState = .results
            } catch {
                appState.apiError = "Video error: \(error.localizedDescription)"
                appState.viewState = .idle
                videoProcessingStatus = ""
            }
        }
    }

    /// Extract evenly-spaced frames from a video file.
    private func extractFrames(from url: URL, maxFrames: Int, intervalSeconds: Double) async throws -> [UIImage] {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let durationSeconds = CMTimeGetSeconds(duration)
        guard durationSeconds > 0 else { return [] }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 720)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)

        let step = max(intervalSeconds, durationSeconds / Double(maxFrames))
        var times: [CMTime] = []
        var t = 0.0
        while t < durationSeconds && times.count < maxFrames {
            times.append(CMTime(seconds: t, preferredTimescale: 600))
            t += step
        }

        var images: [UIImage] = []
        for time in times {
            if let cgImage = try? generator.copyCGImage(at: time, actualTime: nil) {
                images.append(UIImage(cgImage: cgImage))
            }
        }
        return images
    }

    // MARK: - Animations

    private func startAnimations() {
        // Scan line
        withAnimation(.easeInOut(duration: 2.5).repeatForever(autoreverses: true)) {
            scanLinePosition = 0.85
        }
        // Bracket glow
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
            bracketOpacity = 1.0
        }
    }
}

// MARK: - Corner Bracket Shape

private struct CornerBracket: View {
    let index: Int // 0=TL, 1=TR, 2=BL, 3=BR
    let size: CGFloat
    let color: Color
    let lineWidth: CGFloat

    var body: some View {
        Canvas { context, canvasSize in
            var path = Path()
            let w = canvasSize.width
            let h = canvasSize.height
            let r: CGFloat = 12 // corner radius

            switch index {
            case 0: // top-left
                path.move(to: CGPoint(x: 0, y: h))
                path.addLine(to: CGPoint(x: 0, y: r))
                path.addQuadCurve(to: CGPoint(x: r, y: 0), control: .zero)
                path.addLine(to: CGPoint(x: w, y: 0))
            case 1: // top-right
                path.move(to: CGPoint(x: 0, y: 0))
                path.addLine(to: CGPoint(x: w - r, y: 0))
                path.addQuadCurve(to: CGPoint(x: w, y: r), control: CGPoint(x: w, y: 0))
                path.addLine(to: CGPoint(x: w, y: h))
            case 2: // bottom-left
                path.move(to: CGPoint(x: 0, y: 0))
                path.addLine(to: CGPoint(x: 0, y: h - r))
                path.addQuadCurve(to: CGPoint(x: r, y: h), control: CGPoint(x: 0, y: h))
                path.addLine(to: CGPoint(x: w, y: h))
            case 3: // bottom-right
                path.move(to: CGPoint(x: w, y: 0))
                path.addLine(to: CGPoint(x: w, y: h - r))
                path.addQuadCurve(to: CGPoint(x: w - r, y: h), control: CGPoint(x: w, y: h))
                path.addLine(to: CGPoint(x: 0, y: h))
            default: break
            }

            context.stroke(path, with: .color(color), lineWidth: lineWidth)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Video Transferable

struct VideoTransferable: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension("mov")
            try FileManager.default.copyItem(at: received.file, to: tempURL)
            return Self(url: tempURL)
        }
    }
}

// MARK: - Shimmer Bar

struct ShimmerBar: View {
    @State private var offset: CGFloat = -200

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(Color.white.opacity(0.08))
            .overlay {
                LinearGradient(
                    colors: [.clear, .white.opacity(0.08), .clear],
                    startPoint: .leading, endPoint: .trailing
                )
                .offset(x: offset)
                .onAppear {
                    withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: false)) {
                        offset = 200
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 2))
    }
}
