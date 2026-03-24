import AVFoundation
import UIKit

/// Uses the iPhone's back camera as a frame source for testing
/// the full pipeline without Meta glasses.
final class CameraStreamProvider: NSObject, StreamProvider, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let captureSession = AVCaptureSession()
    private let outputQueue = DispatchQueue(label: "com.inventoryglasses.camera-output")

    private var stateContinuation: AsyncStream<StreamProviderState>.Continuation?
    private var frameContinuation: AsyncStream<UIImage>.Continuation?

    let stateStream: AsyncStream<StreamProviderState>
    let frameStream: AsyncStream<UIImage>

    override init() {
        var sc: AsyncStream<StreamProviderState>.Continuation!
        stateStream = AsyncStream { sc = $0 }
        var fc: AsyncStream<UIImage>.Continuation!
        frameStream = AsyncStream { fc = $0 }
        super.init()
        stateContinuation = sc
        frameContinuation = fc
    }

    func start() async throws {
        stateContinuation?.yield(.starting)

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw NSError(domain: "CameraStream", code: 1, userInfo: [NSLocalizedDescriptionKey: "No back camera available"])
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard captureSession.canAddInput(input) else {
            throw NSError(domain: "CameraStream", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add camera input"])
        }
        captureSession.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: outputQueue)
        output.alwaysDiscardsLateVideoFrames = true

        guard captureSession.canAddOutput(output) else {
            throw NSError(domain: "CameraStream", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot add video output"])
        }
        captureSession.addOutput(output)
        captureSession.sessionPreset = .medium

        let continuation = stateContinuation
        DispatchQueue.global(qos: .userInitiated).async { [captureSession] in
            captureSession.startRunning()
            continuation?.yield(.streaming)
        }
    }

    func stop() async {
        captureSession.stopRunning()
        stateContinuation?.yield(.stopped)
        stateContinuation?.finish()
        frameContinuation?.finish()
    }

    // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        let uiImage = UIImage(cgImage: cgImage)
        frameContinuation?.yield(uiImage)
    }
}
