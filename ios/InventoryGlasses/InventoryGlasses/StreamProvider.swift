import UIKit

enum StreamSource {
    case glasses
    case camera
}

enum StreamProviderState {
    case stopped, waitingForDevice, starting, streaming, paused, stopping
}

protocol StreamProvider: AnyObject {
    func start() async throws
    func stop() async

    /// Async stream of provider state changes.
    var stateStream: AsyncStream<StreamProviderState> { get }

    /// Async stream of captured frames as UIImage.
    var frameStream: AsyncStream<UIImage> { get }
}
