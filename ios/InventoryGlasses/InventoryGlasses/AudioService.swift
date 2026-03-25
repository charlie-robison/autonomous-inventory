import AVFoundation
import Foundation

/// Always-on voice listening for mode selection.
/// Captures 16kHz mono PCM, sends 2-second chunks to the server for transcription,
/// then fuzzy-matches wake word + mode from the result.
@MainActor
final class AudioService: ObservableObject {
    @Published var isListening = false
    @Published var isTranscribing = false
    @Published var modeStatus = ""
    @Published var detectedMode: AppMode?

    private var audioEngine: AVAudioEngine?
    private var pcmBuffer: [Float] = []
    private var listeningTask: Task<Void, Never>?
    private var isRunning = false

    func startListening(serverIP: String) {
        guard !isRunning else { return }
        isRunning = true
        isListening = true
        modeStatus = "Say 'Jarvis' + mode..."

        listeningTask = Task { [weak self] in
            await self?.listenLoop(serverIP: serverIP)
        }
    }

    func stopListening() {
        isRunning = false
        listeningTask?.cancel()
        listeningTask = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        isListening = false
        modeStatus = ""
    }

    // MARK: - Private

    private func listenLoop(serverIP: String) async {
        // Configure audio session
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement)
            try audioSession.setActive(true)
        } catch {
            modeStatus = "Microphone access failed"
            isRunning = false
            isListening = false
            return
        }

        let engine = AVAudioEngine()
        self.audioEngine = engine

        let inputNode = engine.inputNode
        let nativeFormat = inputNode.outputFormat(forBus: 0)

        // Target: 16kHz mono Float32
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ) else {
            modeStatus = "Audio format error"
            isRunning = false
            isListening = false
            return
        }

        guard let converter = AVAudioConverter(from: nativeFormat, to: targetFormat) else {
            modeStatus = "Audio converter error"
            isRunning = false
            isListening = false
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: nativeFormat) { [weak self] buffer, _ in
            guard let self, self.isRunning else { return }

            let frameCount = AVAudioFrameCount(
                Double(buffer.frameLength) * 16000.0 / nativeFormat.sampleRate
            )
            guard frameCount > 0,
                  let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCount) else {
                return
            }

            var error: NSError?
            converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }

            if error == nil, let floatData = convertedBuffer.floatChannelData?[0] {
                let count = Int(convertedBuffer.frameLength)
                let samples = Array(UnsafeBufferPointer(start: floatData, count: count))
                Task { @MainActor in
                    self.pcmBuffer.append(contentsOf: samples)
                }
            }
        }

        do {
            try engine.start()
        } catch {
            modeStatus = "Microphone start failed"
            isRunning = false
            isListening = false
            return
        }

        // Process 2-second chunks
        while isRunning && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard isRunning else { break }

            let chunks = pcmBuffer
            pcmBuffer = []
            guard !chunks.isEmpty else { continue }

            // Skip silence (peak < 0.01)
            let peak = chunks.reduce(0) { max($0, abs($1)) }
            guard peak >= 0.01 else { continue }

            // Normalize quiet audio
            let gain: Float = (peak > 0 && peak < 0.25) ? 0.9 / peak : 1.0

            // Convert Float32 to Int16 PCM
            var pcm16 = Data(count: chunks.count * 2)
            pcm16.withUnsafeMutableBytes { rawBuffer in
                let int16Buffer = rawBuffer.bindMemory(to: Int16.self)
                for i in 0..<chunks.count {
                    let s = max(-1.0, min(1.0, chunks[i] * gain))
                    int16Buffer[i] = s < 0
                        ? Int16(s * Float(0x8000))
                        : Int16(s * Float(0x7FFF))
                }
            }

            isTranscribing = true
            let text = await transcribe(pcm16: pcm16, serverIP: serverIP)
            isTranscribing = false

            guard isRunning, !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }

            if let mode = Self.detectMode(text) {
                modeStatus = "Heard \"\(text)\" — setting \(mode.rawValue)..."
                detectedMode = mode

                // Brief pause before resetting status
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if isRunning {
                    modeStatus = "Say 'Jarvis' + mode..."
                }
            }
        }

        engine.stop()
        inputNode.removeTap(onBus: 0)
        self.audioEngine = nil
        isListening = false
    }

    /// Send PCM to a fresh audio WebSocket and get transcription back.
    private func transcribe(pcm16: Data, serverIP: String) async -> String {
        await withCheckedContinuation { continuation in
            let urlString = "\(ServerURL.ws(serverIP))/ws/audio-stream"
            guard let url = URL(string: urlString) else {
                continuation.resume(returning: "")
                return
            }

            let session = URLSession(configuration: .default)
            let ws = session.webSocketTask(with: url)
            ws.resume()

            var resolved = false
            let resolveOnce: (String) -> Void = { text in
                guard !resolved else { return }
                resolved = true
                ws.cancel(with: .normalClosure, reason: nil)
                session.invalidateAndCancel()
                continuation.resume(returning: text)
            }

            // 10-second timeout
            Task {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                resolveOnce("")
            }

            func listen() {
                ws.receive { result in
                    switch result {
                    case .success(let message):
                        if case .string(let text) = message,
                           let data = text.data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                            let type = json["type"] as? String
                            if type == "status", json["message"] as? String == "ready" {
                                // Send PCM audio
                                ws.send(.data(pcm16)) { _ in
                                    // Send transcribe command
                                    let cmd = "{\"action\":\"transcribe\"}"
                                    ws.send(.string(cmd)) { _ in }
                                }
                                listen()
                            } else if type == "transcription" {
                                resolveOnce(json["text"] as? String ?? "")
                            } else if type == "error" {
                                resolveOnce("")
                            } else {
                                listen()
                            }
                        } else {
                            listen()
                        }
                    case .failure:
                        resolveOnce("")
                    }
                }
            }
            listen()
        }
    }

    // MARK: - Wake Word + Mode Detection (ported from frontend)

    private static let wakeRegex = try! NSRegularExpression(
        pattern: #"\b(jarvis|jarvas|jarves|jarvus|jarv[iy]s|jarbus|gervis|jervis|jarv|jarb[iy]s|jarfis|jarbis|service|java[s']?|travis|elvis)\b"#,
        options: .caseInsensitive
    )

    private static let modeAnchors: [AppMode: [String]] = [
        .receive: ["receive", "receiving", "received", "reseive", "recieve", "resiv", "receipt",
                    "recede", "believe", "retrieve", "receiv"],
        .load: ["load", "loading", "loaded", "lode", "lowed", "loud", "loat", "lote", "lord",
                "lod", "loader"],
        .count: ["count", "counting", "counted", "cound", "mount", "caunt", "cant", "kount",
                 "coun", "recount", "account", "county", "counter"],
    ]

    static func detectMode(_ text: String) -> AppMode? {
        let nsText = text as NSString
        let range = NSRange(location: 0, length: nsText.length)
        guard let match = wakeRegex.firstMatch(in: text, range: range) else { return nil }

        let afterIndex = match.range.location + match.range.length
        let after = nsText.substring(from: afterIndex)
            .trimmingCharacters(in: .whitespaces)
        guard !after.isEmpty else { return nil }

        let words = after.lowercased()
            .components(separatedBy: .letters.inverted)
            .filter { !$0.isEmpty }
        guard !words.isEmpty else { return nil }

        var bestMode: AppMode?
        var bestDist = 999

        for (mode, anchors) in modeAnchors {
            for word in words {
                for anchor in anchors {
                    let d = levenshtein(word, anchor)
                    if d < bestDist {
                        bestDist = d
                        bestMode = mode
                    }
                }
            }
        }

        return bestDist <= 3 ? bestMode : nil
    }

    /// Levenshtein edit distance.
    private static func levenshtein(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.count < b.count { return levenshtein(String(b), String(a)) }
        if b.isEmpty { return a.count }

        var prev = Array(0...b.count)
        for i in 0..<a.count {
            var curr = [i + 1]
            for j in 0..<b.count {
                curr.append(min(
                    prev[j + 1] + 1,
                    curr[j] + 1,
                    prev[j] + (a[i] != b[j] ? 1 : 0)
                ))
            }
            prev = curr
        }
        return prev[b.count]
    }
}
