import Combine
import Foundation
import UIKit

/// Uploads JPEG frames to the backend via WebSocket (primary) or HTTP POST (fallback).
final class FrameUploader: ObservableObject {
    @Published var isConnected = false
    @Published var framesSent: Int = 0
    @Published var lastError: String?

    /// Minimum seconds between frame uploads (server can adjust via config message).
    var frameInterval: TimeInterval = 1.0

    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var lastSendTime: TimeInterval = 0
    private var serverBaseURL: String = ""
    private var cancellables = Set<AnyCancellable>()

    // MARK: - WebSocket Connection

    /// Connect to the backend WebSocket endpoint.
    func connect(serverIP: String, port: Int = 8000) {
        disconnect()

        serverBaseURL = "http://\(serverIP):\(port)"
        let wsURL = URL(string: "ws://\(serverIP):\(port)/api/stream/ws/dat-upload")!

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config)

        webSocket = session?.webSocketTask(with: wsURL)
        webSocket?.resume()
        isConnected = true
        lastError = nil

        listenForMessages()
    }

    /// Disconnect the WebSocket.
    func disconnect() {
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    // MARK: - Frame Upload

    /// Send a frame if enough time has elapsed since the last send.
    /// Returns true if the frame was sent, false if throttled.
    @discardableResult
    func sendFrame(_ image: UIImage) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastSendTime >= frameInterval else {
            return false // Throttled
        }
        lastSendTime = now

        guard let jpegData = image.jpegData(compressionQuality: 0.8) else {
            return false
        }

        if let ws = webSocket, isConnected {
            sendViaWebSocket(ws, data: jpegData)
        } else {
            sendViaHTTP(data: jpegData)
        }

        return true
    }

    // MARK: - Private

    private func sendViaWebSocket(_ ws: URLSessionWebSocketTask, data: Data) {
        let message = URLSessionWebSocketTask.Message.data(data)
        ws.send(message) { [weak self] error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.lastError = error.localizedDescription
                    self?.isConnected = false
                    // Fall back to HTTP for this frame
                    self?.sendViaHTTP(data: data)
                } else {
                    self?.framesSent += 1
                }
            }
        }
    }

    private func sendViaHTTP(data: Data) {
        guard !serverBaseURL.isEmpty else { return }

        let url = URL(string: "\(serverBaseURL)/api/stream/dat-upload")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"frame.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.lastError = "HTTP fallback: \(error.localizedDescription)"
                } else if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    self?.framesSent += 1
                }
            }
        }.resume()
    }

    private func listenForMessages() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let type = json["type"] as? String, type == "config",
                   let interval = json["frame_interval"] as? Double {
                    DispatchQueue.main.async {
                        self?.frameInterval = interval
                    }
                }
                // Continue listening
                self?.listenForMessages()
            case .failure:
                DispatchQueue.main.async {
                    self?.isConnected = false
                }
            }
        }
    }
}
