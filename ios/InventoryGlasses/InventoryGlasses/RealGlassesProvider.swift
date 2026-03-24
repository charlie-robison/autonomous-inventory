import UIKit
import MWDATCore
import MWDATCamera

final class RealGlassesProvider: StreamProvider, @unchecked Sendable {
    private var session: StreamSession?
    private var stateToken: (any AnyListenerToken)?
    private var frameToken: (any AnyListenerToken)?

    private let stateContinuation: AsyncStream<StreamProviderState>.Continuation
    private let frameContinuation: AsyncStream<UIImage>.Continuation

    let stateStream: AsyncStream<StreamProviderState>
    let frameStream: AsyncStream<UIImage>

    init() {
        var sc: AsyncStream<StreamProviderState>.Continuation!
        stateStream = AsyncStream { sc = $0 }
        var fc: AsyncStream<UIImage>.Continuation!
        frameStream = AsyncStream { fc = $0 }
        stateContinuation = sc
        frameContinuation = fc
    }

    func start() async throws {
        let config = StreamSessionConfig(
            videoCodec: .raw,
            resolution: .low,
            frameRate: 24
        )

        let deviceSelector = AutoDeviceSelector(wearables: Wearables.shared)
        let session = StreamSession(
            streamSessionConfig: config,
            deviceSelector: deviceSelector
        )
        self.session = session

        stateToken = session.statePublisher.listen { [weak self] (state: StreamSessionState) in
            let mapped: StreamProviderState
            switch state {
            case .stopped:          mapped = .stopped
            case .waitingForDevice: mapped = .waitingForDevice
            case .starting:         mapped = .starting
            case .streaming:        mapped = .streaming
            case .paused:           mapped = .paused
            case .stopping:         mapped = .stopping
            }
            self?.stateContinuation.yield(mapped)
        }

        frameToken = session.videoFramePublisher.listen { [weak self] (frame: VideoFrame) in
            if let image = frame.makeUIImage() {
                self?.frameContinuation.yield(image)
            }
        }

        await session.start()
        stateContinuation.yield(.starting)
    }

    func stop() async {
        if let stateToken { await stateToken.cancel() }
        if let frameToken { await frameToken.cancel() }
        await session?.stop()
        session = nil
        self.stateToken = nil
        self.frameToken = nil
        stateContinuation.yield(.stopped)
        stateContinuation.finish()
        frameContinuation.finish()
    }
}
