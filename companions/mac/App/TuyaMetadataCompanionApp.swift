import SwiftUI

@main
@MainActor
struct TuyaMetadataCompanionApp: App {
    @StateObject private var model = CompanionModel()
    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .frame(minWidth: 740, minHeight: 640)
        }
    }
}
