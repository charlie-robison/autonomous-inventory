import Foundation
import UIKit

/// Sends frames to mode-specific WebSocket endpoints and returns parsed results.
/// Each call opens a fresh WebSocket, sends one JPEG, waits for the JSON response, then closes.
@MainActor
final class PipelineService: ObservableObject {

    private let jpegQuality: CGFloat = 0.85
    private let timeoutSeconds: TimeInterval = 15

    // MARK: - Public API

    /// Count mode: send frame to /api/stream/ws/count, return item list.
    func sendToCount(image: UIImage, serverIP: String) async throws -> [ScanResult] {
        let json = try await sendToWs(path: "count", image: image, serverIP: serverIP)
        guard let items = json["items_updated"] as? [[String: Any]] else {
            return []
        }
        return items.compactMap { dict in
            guard let name = dict["product_name"] as? String ?? dict["name"] as? String else { return nil }
            let count = dict["facing_count"] as? Int ?? dict["count"] as? Int ?? 1
            return ScanResult(name: name, count: count)
        }
    }

    /// Scan QR: send frame to /api/stream/ws/scan-qr, return pallet ID.
    func sendToScanQR(image: UIImage, serverIP: String) async throws -> String {
        let json = try await sendToWs(path: "scan-qr", image: image, serverIP: serverIP)
        guard let status = json["status"] as? String, status == "ok",
              let palletId = json["pallet_id"] as? String else {
            let message = json["message"] as? String ?? "No QR code detected"
            throw PipelineError.detection(message)
        }
        return palletId
    }

    /// Scan vehicle: send frame to /api/stream/ws/scan-vehicle, return vehicle name.
    func sendToScanVehicle(image: UIImage, serverIP: String) async throws -> String {
        let json = try await sendToWs(path: "scan-vehicle", image: image, serverIP: serverIP)
        guard let status = json["status"] as? String, status == "ok",
              let vehicleName = json["vehicle_name"] as? String else {
            let message = json["message"] as? String ?? "No vehicle number detected"
            throw PipelineError.detection(message)
        }
        return vehicleName
    }

    // MARK: - Private

    private func sendToWs(path: String, image: UIImage, serverIP: String) async throws -> [String: Any] {
        guard let jpegData = image.jpegData(compressionQuality: jpegQuality) else {
            throw PipelineError.invalidImage
        }

        let urlString = "\(ServerURL.ws(serverIP))/api/stream/ws/\(path)"
        guard let url = URL(string: urlString) else {
            throw PipelineError.invalidURL(urlString)
        }

        let session = URLSession(configuration: .default)
        let wsTask = session.webSocketTask(with: url)
        wsTask.resume()

        defer {
            wsTask.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        }

        // Send binary JPEG
        try await wsTask.send(.data(jpegData))

        // Wait for JSON response with timeout
        return try await withThrowingTaskGroup(of: [String: Any].self) { group in
            group.addTask {
                let message = try await wsTask.receive()
                switch message {
                case .string(let text):
                    guard let data = text.data(using: .utf8),
                          let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        throw PipelineError.invalidResponse
                    }
                    return json
                case .data(let data):
                    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        throw PipelineError.invalidResponse
                    }
                    return json
                @unknown default:
                    throw PipelineError.invalidResponse
                }
            }

            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(self.timeoutSeconds * 1_000_000_000))
                throw PipelineError.timeout
            }

            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }
}

// MARK: - Errors

enum PipelineError: LocalizedError {
    case invalidImage
    case invalidURL(String)
    case invalidResponse
    case timeout
    case detection(String)

    var errorDescription: String? {
        switch self {
        case .invalidImage: return "Failed to encode image"
        case .invalidURL(let url): return "Invalid URL: \(url)"
        case .invalidResponse: return "Invalid server response"
        case .timeout: return "Request timed out"
        case .detection(let msg): return msg
        }
    }
}
