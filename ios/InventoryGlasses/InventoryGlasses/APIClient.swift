import Foundation

// MARK: - Shared URL Builder

/// Builds HTTP and WebSocket base URLs from the serverIP field.
/// Accepts either a plain IP ("192.168.1.100") or a full URL ("https://foo.ngrok-free.dev").
enum ServerURL {
    /// Returns an HTTP(S) base URL like "http://192.168.1.100:8000" or "https://foo.ngrok-free.dev"
    static func http(_ serverIP: String) -> String {
        let trimmed = serverIP.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            // Full URL — strip trailing slash
            return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        }
        // Plain IP — add http:// and port
        return "http://\(trimmed):8000"
    }

    /// Returns a WebSocket base URL like "ws://192.168.1.100:8000" or "wss://foo.ngrok-free.dev"
    static func ws(_ serverIP: String) -> String {
        let httpBase = http(serverIP)
        return httpBase
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
    }
}

// MARK: - REST API Client

enum APIClient {

    // MARK: - Mode

    static func getMode(serverIP: String) async throws -> String {
        let data = try await get("\(ServerURL.http(serverIP))/api/mode")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = json["current_mode"] as? String else {
            throw APIError.invalidResponse
        }
        return mode
    }

    static func setMode(serverIP: String, mode: AppMode) async throws {
        let body = ["mode": mode.rawValue]
        _ = try await post("\(ServerURL.http(serverIP))/api/mode", json: body)
    }

    // MARK: - Pallets

    static func getPallets(serverIP: String) async throws -> [Pallet] {
        let data = try await get("\(ServerURL.http(serverIP))/api/pallets")
        return try JSONDecoder().decode([Pallet].self, from: data)
    }

    static func receivePallet(
        serverIP: String,
        palletId: String,
        lat: Double,
        lng: Double
    ) async throws -> [String: String] {
        let body: [String: Any] = ["lat": lat, "lng": lng]
        let encoded = palletId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? palletId
        let data = try await post(
            "\(ServerURL.http(serverIP))/api/pallets/\(encoded)/receive",
            json: body
        )
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.invalidResponse
        }
        var result: [String: String] = [:]
        for (key, value) in json { result[key] = "\(value)" }
        return result
    }

    static func loadPallet(
        serverIP: String,
        palletId: String,
        vehicleName: String
    ) async throws -> [String: String] {
        let body: [String: Any] = ["vehicle_name": vehicleName]
        let encoded = palletId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? palletId
        let data = try await post(
            "\(ServerURL.http(serverIP))/api/pallets/\(encoded)/load",
            json: body
        )
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.invalidResponse
        }
        var result: [String: String] = [:]
        for (key, value) in json { result[key] = "\(value)" }
        return result
    }

    // MARK: - Connection Test

    static func testConnection(serverIP: String) async -> String? {
        let urlString = "\(ServerURL.http(serverIP))/health"
        print("[API] Testing connection to: \(urlString)")
        guard let url = URL(string: urlString) else {
            return "Invalid URL: \(urlString)"
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: data, encoding: .utf8) ?? "(empty)"
            print("[API] Health check response: \(status) — \(body)")
            if (200...299).contains(status) {
                return nil
            }
            return "Server returned \(status)"
        } catch {
            print("[API] Health check FAILED: \(error)")
            return error.localizedDescription
        }
    }

    // MARK: - Private Helpers

    private static func get(_ urlString: String) async throws -> Data {
        guard let url = URL(string: urlString) else { throw APIError.invalidURL }
        print("[API] GET \(urlString)")
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            print("[API] GET \(urlString) → \(status)")
            guard (200...299).contains(status) else { throw APIError.serverError }
            return data
        } catch {
            print("[API] GET \(urlString) FAILED: \(error)")
            throw error
        }
    }

    private static func post(_ urlString: String, json body: [String: Any]) async throws -> Data {
        guard let url = URL(string: urlString) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        print("[API] POST \(urlString)")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            print("[API] POST \(urlString) → \(status)")
            guard (200...299).contains(status) else { throw APIError.serverError }
            return data
        } catch {
            print("[API] POST \(urlString) FAILED: \(error)")
            throw error
        }
    }
}

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case serverError

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL"
        case .invalidResponse: return "Invalid server response"
        case .serverError: return "Server error"
        }
    }
}
