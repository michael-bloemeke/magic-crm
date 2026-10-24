import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // BloomBridgeViewController = Capacitor's controller plus the WidgetBridge plugin
        // (WidgetBridge.swift), which the home-screen widgets need.
        window?.rootViewController = BloomBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // Opened cold by tapping a widget: the bloomcrm:// link arrives here, not in openURLContexts.
        if let url = connectionOptions.urlContexts.first?.url { WidgetLink.receive(url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        // A widget tap while the app is already running.
        for ctx in URLContexts { WidgetLink.receive(ctx.url) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
