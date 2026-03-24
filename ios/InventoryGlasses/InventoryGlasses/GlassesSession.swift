import Combine
import UIKit
// When using the real DAT SDK, replace MockDAT/ with:
// import WearablesDeviceAccessToolkit

/// Wraps the DAT SDK StreamSession, receiving video frames from Meta glasses.
final class GlassesSession: ObservableObject {
    @Published var isConnected = false
    @Published var latestImage: UIImage?
    @Published var error: String?

    private var streamSession: StreamSession?
    private var cancellables = Set<AnyCancellable>()

    /// Start the DAT SDK stream session with the connected glasses.
    func start() {
        guard streamSession == nil else { return }

        let config = StreamSessionConfiguration(
            resolution: .low,       // 360x640 — sufficient for VLM
            frameRate: 24,
            videoCodec: .raw        // Raw frames we can convert to UIImage
        )

        do {
            streamSession = try StreamSession(configuration: config)
        } catch {
            self.error = "Failed to create stream session: \(error.localizedDescription)"
            return
        }

        guard let session = streamSession else { return }

        session.statePublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.isConnected = (state == .streaming)
            }
            .store(in: &cancellables)

        session.videoFramePublisher
            .receive(on: DispatchQueue.global(qos: .userInitiated))
            .compactMap { frame -> UIImage? in
                frame.makeUIImage()
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] image in
                self?.latestImage = image
            }
            .store(in: &cancellables)

        session.start()
        isConnected = true
    }

    /// Stop the stream session and release resources.
    func stop() {
        streamSession?.stop()
        streamSession = nil
        cancellables.removeAll()
        isConnected = false
        latestImage = nil
    }
}
