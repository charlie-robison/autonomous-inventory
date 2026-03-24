import UIKit
import AVFoundation
import MWDATCore

/// Orchestrates streaming from either real Meta glasses or the iPhone camera fallback.
@MainActor
final class GlassesSession: ObservableObject {
    @Published var isConnected = false
    @Published var latestImage: UIImage?
    @Published var error: String?
    @Published var source: StreamSource = .camera
    @Published var isRegistered = false
    @Published var statusMessage: String = ""

    private var provider: StreamProvider?
    private var stateTask: Task<Void, Never>?
    private var frameTask: Task<Void, Never>?
    private var registrationTask: Task<Void, Never>?

    /// Check if already registered (handles known + hidden enum cases).
    private func checkRegistration() -> Bool {
        let state = Wearables.shared.registrationState
        // .available (rawValue 1) or hidden registered state (rawValue 3)
        return state == .available || state.rawValue == 3
    }

    /// Attempt to register with Meta AI app.
    func register() {
        if checkRegistration() {
            print("[InventoryGlasses] Already registered, switching to glasses")
            isRegistered = true
            switchToGlasses()
            return
        }

        print("[InventoryGlasses] Starting registration...")
        registrationTask = Task {
            do {
                try await Wearables.shared.startRegistration()
                for await state in Wearables.shared.registrationStateStream() {
                    print("[InventoryGlasses] Registration state: \(state) rawValue: \(state.rawValue)")
                    if state == .available || state.rawValue == 3 {
                        isRegistered = true
                        switchToGlasses()
                        return
                    }
                }
            } catch let regError as RegistrationError {
                print("[InventoryGlasses] RegistrationError: \(regError) rawValue: \(regError.rawValue)")
                if regError == .alreadyRegistered {
                    isRegistered = true
                    switchToGlasses()
                } else {
                    self.error = "Registration failed: \(regError)"
                }
            } catch {
                print("[InventoryGlasses] Registration error: \(error)")
                if checkRegistration() {
                    isRegistered = true
                    switchToGlasses()
                } else {
                    self.error = "Registration failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func switchToGlasses() {
        stop()
        startWithGlasses()
    }

    /// Start streaming — camera immediately, or glasses if registered.
    func start() {
        guard provider == nil else { return }

        #if targetEnvironment(simulator)
        startWithCamera()
        #else
        // Always start camera first for instant feedback
        // Then try glasses in background if registered
        if checkRegistration() {
            isRegistered = true
            startWithGlasses()
        } else {
            startWithCamera()
        }
        #endif
    }

    /// Start with real Meta glasses — waits for device discovery + permission.
    func startWithGlasses() {
        print("[InventoryGlasses] Starting glasses flow...")
        statusMessage = "Waiting for glasses..."
        source = .glasses

        Task {
            // Step 1: Wait for a device to appear (Bluetooth may still be powering on)
            print("[InventoryGlasses] Waiting for device discovery...")
            statusMessage = "Connecting to glasses..."

            var deviceId: String? = nil
            let discoveryTimeout: Task<Void, Never> = Task {
                try? await Task.sleep(nanoseconds: 15_000_000_000) // 15s timeout
            }

            // Check if devices already available
            let currentDevices = Wearables.shared.devices
            if !currentDevices.isEmpty {
                deviceId = currentDevices.first
                print("[InventoryGlasses] Device already available: \(deviceId ?? "")")
            } else {
                // Wait for devices to appear
                for await devices in Wearables.shared.devicesStream() {
                    print("[InventoryGlasses] Devices updated: \(devices)")
                    if let first = devices.first {
                        deviceId = first
                        break
                    }
                    // Check if timed out
                    if discoveryTimeout.isCancelled { break }
                }
            }
            discoveryTimeout.cancel()

            guard deviceId != nil else {
                print("[InventoryGlasses] No glasses found after timeout, falling back to camera")
                statusMessage = ""
                self.error = "No glasses found. Using camera."
                startWithCamera()
                return
            }

            print("[InventoryGlasses] Device found: \(deviceId!)")
            statusMessage = "Requesting permission..."

            // Step 2: Request camera permission on glasses
            do {
                let status = try await Wearables.shared.requestPermission(.camera)
                print("[InventoryGlasses] Permission status: \(status)")
                if status != .granted {
                    print("[InventoryGlasses] Permission denied, falling back to camera")
                    statusMessage = ""
                    self.error = "Glasses camera permission denied. Using phone camera."
                    startWithCamera()
                    return
                }
            } catch {
                print("[InventoryGlasses] Permission error: \(error), type: \(type(of: error))")
                // Permission might have been granted via callback URL already, continue anyway
                print("[InventoryGlasses] Continuing despite permission error (may have been granted via callback)")
            }

            // Step 3: Start streaming from glasses
            statusMessage = "Starting stream..."
            let realProvider = RealGlassesProvider()
            self.provider = realProvider
            subscribeToProvider(realProvider)

            do {
                try await realProvider.start()
                print("[InventoryGlasses] Glasses streaming started!")
                statusMessage = ""
            } catch {
                print("[InventoryGlasses] Glasses stream failed: \(error)")
                self.error = "Glasses stream failed: \(error.localizedDescription). Using camera."
                await realProvider.stop()
                self.provider = nil
                statusMessage = ""
                startWithCamera()
            }
        }
    }

    /// Start with the iPhone camera fallback.
    private func startWithCamera() {
        print("[InventoryGlasses] Starting with camera...")
        source = .camera
        statusMessage = ""
        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        switch authStatus {
        case .authorized:
            launchCamera()
        case .notDetermined:
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                if granted {
                    launchCamera()
                } else {
                    self.error = "Camera access denied. Enable in Settings > Privacy > Camera."
                }
            }
        default:
            self.error = "Camera access denied. Enable in Settings > Privacy > Camera."
        }
    }

    private func launchCamera() {
        let cameraProvider = CameraStreamProvider()
        self.provider = cameraProvider
        subscribeToProvider(cameraProvider)

        Task {
            do {
                try await cameraProvider.start()
                print("[InventoryGlasses] Camera streaming started")
            } catch {
                print("[InventoryGlasses] Camera failed: \(error)")
                self.error = "Camera failed: \(error.localizedDescription)"
            }
        }
    }

    private func subscribeToProvider(_ provider: StreamProvider) {
        stateTask?.cancel()
        frameTask?.cancel()

        stateTask = Task {
            for await state in provider.stateStream {
                self.isConnected = (state == .streaming)
            }
        }

        frameTask = Task {
            for await image in provider.frameStream {
                self.latestImage = image
            }
        }
    }

    /// Stop streaming and release resources.
    func stop() {
        stateTask?.cancel()
        frameTask?.cancel()
        stateTask = nil
        frameTask = nil

        if let provider = provider {
            Task {
                await provider.stop()
            }
        }
        provider = nil
        isConnected = false
        latestImage = nil
        statusMessage = ""
    }
}
