import SwiftUI
import MWDATCore

@main
struct InventoryGlassesApp: App {
    init() {
        #if !targetEnvironment(simulator)
        do {
            try Wearables.configure()
            print("[InventoryGlasses] Wearables SDK configured successfully")
            print("[InventoryGlasses] Initial registrationState: \(Wearables.shared.registrationState)")
        } catch {
            print("[InventoryGlasses] Wearables SDK configuration FAILED: \(error)")
            print("[InventoryGlasses] Error type: \(type(of: error))")
        }
        #else
        print("[InventoryGlasses] Running on simulator, skipping Wearables SDK")
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in
                    print("[InventoryGlasses] Received callback URL: \(url)")
                    print("[InventoryGlasses] URL scheme: \(url.scheme ?? "nil")")
                    print("[InventoryGlasses] URL host: \(url.host ?? "nil")")
                    print("[InventoryGlasses] URL path: \(url.path)")
                    print("[InventoryGlasses] URL query: \(url.query ?? "nil")")
                    Task {
                        do {
                            let handled = try await Wearables.shared.handleUrl(url)
                            print("[InventoryGlasses] handleUrl result: \(handled)")
                        } catch {
                            print("[InventoryGlasses] handleUrl FAILED: \(error)")
                            print("[InventoryGlasses] handleUrl error type: \(type(of: error))")
                        }
                    }
                }
        }
    }
}
