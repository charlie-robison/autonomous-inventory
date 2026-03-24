import SwiftUI
// When using the real DAT SDK, replace MockDAT/ with:
// import WearablesDeviceAccessToolkit

@main
struct InventoryGlassesApp: App {
    init() {
        Wearables.configure()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in
                    Wearables.handleCallbackURL(url)
                }
        }
    }
}
