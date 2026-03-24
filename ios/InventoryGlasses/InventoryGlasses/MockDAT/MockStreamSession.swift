/// Mock StreamSession that uses AVCaptureSession (iPhone camera) instead of
/// Bluetooth glasses, so you can test the full pipeline on a real device.

import AVFoundation
import Combine
import UIKit

// MARK: - SDK Type Stubs

enum StreamResolution {
    case low, medium, high
}

enum StreamVideoCodec {
    case raw, h264
}

struct StreamSessionConfiguration {
    var resolution: StreamResolution = .low
    var frameRate: Int = 24
    var videoCodec: StreamVideoCodec = .raw
}

enum StreamSessionState {
    case idle, connecting, streaming, disconnected
}

struct VideoFrame {
    private let image: UIImage

    init(image: UIImage) {
        self.image = image
    }

    func makeUIImage() -> UIImage? {
        return image
    }
}

// MARK: - StreamSession (camera-backed mock)

final class StreamSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let configuration: StreamSessionConfiguration

    private let captureSession = AVCaptureSession()
    private let outputQueue = DispatchQueue(label: "com.inventoryglasses.camera-output")

    private let _stateSubject = CurrentValueSubject<StreamSessionState, Never>(.idle)
    var statePublisher: AnyPublisher<StreamSessionState, Never> {
        _stateSubject.eraseToAnyPublisher()
    }

    private let _frameSubject = PassthroughSubject<VideoFrame, Never>()
    var videoFramePublisher: AnyPublisher<VideoFrame, Never> {
        _frameSubject.eraseToAnyPublisher()
    }

    init(configuration: StreamSessionConfiguration) throws {
        self.configuration = configuration
        super.init()
        try setupCamera()
    }

    func start() {
        _stateSubject.send(.connecting)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.captureSession.startRunning()
            DispatchQueue.main.async {
                self?._stateSubject.send(.streaming)
            }
        }
    }

    func stop() {
        captureSession.stopRunning()
        _stateSubject.send(.disconnected)
    }

    // MARK: - Camera Setup

    private func setupCamera() throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw NSError(domain: "MockDAT", code: 1, userInfo: [NSLocalizedDescriptionKey: "No back camera available"])
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard captureSession.canAddInput(input) else {
            throw NSError(domain: "MockDAT", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add camera input"])
        }
        captureSession.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: outputQueue)
        output.alwaysDiscardsLateVideoFrames = true

        guard captureSession.canAddOutput(output) else {
            throw NSError(domain: "MockDAT", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot add video output"])
        }
        captureSession.addOutput(output)

        // Match DAT SDK's .low resolution (360x640)
        captureSession.sessionPreset = .medium
    }

    // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        let uiImage = UIImage(cgImage: cgImage)

        let frame = VideoFrame(image: uiImage)
        _frameSubject.send(frame)
    }
}
