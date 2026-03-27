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
    private var listeningTask: Task<Void, Never>?
    private var isRunning = false

    /// Thread-safe buffer for audio samples.
    private let sampleBuffer = AudioSampleBuffer()

    func startListening(serverIP: String) {
        guard !isRunning else { return }
        isRunning = true
        isListening = true
        modeStatus = "Say 'Jarvis' + mode..."
        print("[Audio] startListening serverIP=\(serverIP)")

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
        // Wait a moment for camera to finish setting up its session
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard isRunning else { return }

        // Configure audio session — retry up to 3 times
        let audioSession = AVAudioSession.sharedInstance()
        var configured = false
        for attempt in 1...3 {
            do {
                try audioSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
                try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
                print("[Audio] Audio session configured on attempt \(attempt)")
                configured = true
                break
            } catch {
                print("[Audio] Audio session attempt \(attempt) FAILED: \(error)")
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
        }
        guard configured else {
            modeStatus = "Mic failed — check permissions"
            isRunning = false
            isListening = false
            return
        }

        let engine = AVAudioEngine()
        self.audioEngine = engine

        let inputNode = engine.inputNode
        let nativeFormat = inputNode.outputFormat(forBus: 0)
        print("[Audio] Native format: \(nativeFormat.sampleRate)Hz, \(nativeFormat.channelCount)ch")

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
            print("[Audio] Converter creation failed")
            modeStatus = "Audio converter error"
            isRunning = false
            isListening = false
            return
        }

        let buf = sampleBuffer

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: nativeFormat) { buffer, _ in
            let frameCount = AVAudioFrameCount(
                Double(buffer.frameLength) * 16000.0 / nativeFormat.sampleRate
            )
            guard frameCount > 0,
                  let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCount) else {
                return
            }

            var convError: NSError?
            converter.convert(to: convertedBuffer, error: &convError) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }

            if convError == nil, let floatData = convertedBuffer.floatChannelData?[0] {
                let count = Int(convertedBuffer.frameLength)
                let samples = Array(UnsafeBufferPointer(start: floatData, count: count))
                buf.append(samples)
            }
        }

        do {
            try engine.start()
            print("[Audio] Engine started, listening...")
        } catch {
            print("[Audio] Engine start FAILED: \(error)")
            modeStatus = "Mic start failed: \(error.localizedDescription)"
            isRunning = false
            isListening = false

            return
        }

        // Process 2-second chunks
        while isRunning && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard isRunning else { break }

            let chunks = buf.drain()

            guard !chunks.isEmpty else {
                print("[Audio] Empty buffer, skipping")
                continue
            }

            // Skip silence (peak < 0.01)
            let peak = chunks.reduce(Float(0)) { max($0, abs($1)) }
            if peak < 0.01 {
                continue
            }
            print("[Audio] Chunk: \(chunks.count) samples, peak=\(String(format: "%.3f", peak))")

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
            modeStatus = "Transcribing..."
            let text = await transcribe(pcm16: pcm16, serverIP: serverIP)
            isTranscribing = false

            guard isRunning else { break }

            if text.trimmingCharacters(in: .whitespaces).isEmpty {
                modeStatus = "Say 'Jarvis' + mode..."
                continue
            }

            print("[Audio] Transcription: \"\(text)\"")
            modeStatus = "Heard: \"\(text)\""

            if let mode = Self.detectMode(text) {
                print("[Audio] Mode detected: \(mode.rawValue)")
                modeStatus = "Heard \"\(text)\" → \(mode.rawValue)"
                detectedMode = mode

                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if isRunning {
                    modeStatus = "Say 'Jarvis' + mode..."
                }
            } else {
                print("[Audio] No mode matched in: \"\(text)\"")
                // Show what was heard briefly
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
        print("[Audio] Stopped")
    }

    /// Send PCM to a fresh audio WebSocket and get transcription back.
    private func transcribe(pcm16: Data, serverIP: String) async -> String {
        let urlString = "\(ServerURL.ws(serverIP))/ws/audio-stream"
        print("[Audio] Transcribe via \(urlString) (\(pcm16.count) bytes)")

        return await withCheckedContinuation { continuation in
            guard let url = URL(string: urlString) else {
                print("[Audio] Bad URL: \(urlString)")
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
                print("[Audio] Transcribe timeout")
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
                                print("[Audio] WS ready, sending PCM...")
                                ws.send(.data(pcm16)) { err in
                                    if let err { print("[Audio] PCM send error: \(err)") }
                                    let cmd = "{\"action\":\"transcribe\"}"
                                    ws.send(.string(cmd)) { err in
                                        if let err { print("[Audio] CMD send error: \(err)") }
                                    }
                                }
                                listen()
                            } else if type == "transcription" {
                                let result = json["text"] as? String ?? ""
                                print("[Audio] Got transcription: \"\(result)\"")
                                resolveOnce(result)
                            } else if type == "error" {
                                print("[Audio] Server error: \(json)")
                                resolveOnce("")
                            } else {
                                listen()
                            }
                        } else {
                            listen()
                        }
                    case .failure(let error):
                        print("[Audio] WS receive error: \(error)")
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

// MARK: - Thread-safe sample buffer

/// Simple thread-safe float buffer using os_unfair_lock (safe from any thread).
final class AudioSampleBuffer: @unchecked Sendable {
    private var storage: [Float] = []
    private var lock = os_unfair_lock()

    func append(_ samples: [Float]) {
        os_unfair_lock_lock(&lock)
        storage.append(contentsOf: samples)
        os_unfair_lock_unlock(&lock)
    }

    func drain() -> [Float] {
        os_unfair_lock_lock(&lock)
        let result = storage
        storage = []
        os_unfair_lock_unlock(&lock)
        return result
    }
}
