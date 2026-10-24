import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        #if DEBUG
        // Simulator testing only (never in a TestFlight build): `simctl launch ... -BloomWidgetTestKey K`
        // stores a widget key through the same path the app uses, so the widget hand-off can be
        // tested without signing in.
        if let k = UserDefaults.standard.string(forKey: "BloomWidgetTestKey"), !k.isEmpty {
            _ = WidgetShared.store(key: k, url: "https://yfmacqvcmkogvkcxfjkr.supabase.co/functions/v1/widget-feed")
        }
        #endif
        return true
    }

    // MARK: - APNs registration
    //
    // (WARNING) THESE TWO METHODS ARE LOAD-BEARING AND CAPACITOR DOES NOT ADD THEM FOR YOU.
    //
    // iOS delivers the device token to the AppDelegate, not to the plugin. @capacitor/push-notifications
    // listens for these two NotificationCenter posts and turns them into the JS `registration` /
    // `registrationError` events that app.js waits on. Without them the whole chain looks like it
    // works: permission is granted, register() is called, iOS really does issue a token, and then
    // nothing catches it. No error, no token, no row in push_subscriptions.
    //
    // That is exactly what happened on the first install (2026-09-21): the bell was tapped, iOS
    // granted permission, and the database stayed empty. If native push ever goes silent again,
    // check that these are still here before looking anywhere else.

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
