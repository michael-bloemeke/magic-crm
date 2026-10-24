import Foundation
import Capacitor
import WidgetKit

// THE APP'S HALF OF THE HOME-SCREEN WIDGETS (2026-10-24).
//
// The widgets (the BloomWidgets extension) run outside the app, so they cannot use the app's
// Supabase session. The signed-in web app asks phone-api for a read-only widget key and passes it
// here; this writes it into the App Group that the widgets read, and tells WidgetKit to refresh.
// It also carries the other direction: a tap on a widget opens a bloomcrm:// link, which
// SceneDelegate hands to WidgetLink, and this plugin passes on to app.js to open the right page.
//
// ⚠️ The App Group id, the defaults keys and the URL scheme are shared with
// BloomWidgets/BloomWidgets.swift and with app.js. Change one, change all three.

enum WidgetShared {
    static let group = "group.com.michaelbloemeke.crm"
    static let tokenKey = "widgetToken"
    static let feedURLKey = "feedURL"
    static var defaults: UserDefaults? { UserDefaults(suiteName: group) }

    // ⚠️ THE KEY IS ALSO WRITTEN AS A FILE, and the widgets read the FILE (2026-10-24).
    // The first build kept it only in the shared UserDefaults. On Michael's phone the app minted and
    // stored a key, yet the widget stayed on "Open Bloom CRM once to connect" and not one request
    // ever reached widget-feed. The suspected cause (NOT reproduced on the simulator, where the same
    // code worked) is the widget's process reading a stale copy of the suite it had read before the
    // key existed. A file in the App Group container has no per-process cache, so whatever the cause
    // was, the widget now reads exactly what the app wrote.
    static var keyFile: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("widget-key.json")
    }

    static func store(key: String, url: String) -> Bool {
        defaults?.set(key, forKey: tokenKey)
        defaults?.set(url, forKey: feedURLKey)
        guard let file = keyFile, let data = try? JSONSerialization.data(withJSONObject: ["key": key, "url": url]) else { return false }
        do { try data.write(to: file, options: [.atomic]) } catch { return false }
        WidgetCenter.shared.reloadAllTimelines()
        return true
    }

    static func hasKey() -> Bool {
        if let file = keyFile, let data = try? Data(contentsOf: file),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String], !(obj["key"] ?? "").isEmpty { return true }
        return false
    }

    static func clear() {
        defaults?.removeObject(forKey: tokenKey)
        if let file = keyFile { try? FileManager.default.removeItem(at: file) }
        WidgetCenter.shared.reloadAllTimelines()
    }
}

// A widget link that arrived before app.js was listening (a cold launch from the widget).
enum WidgetLink {
    static var pending: URL?
    static let note = Notification.Name("BloomWidgetLink")

    static func receive(_ url: URL) {
        guard url.scheme == "bloomcrm" else { return }
        pending = url
        NotificationCenter.default.post(name: note, object: url)
    }
}

@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeLink", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(onLink(_:)), name: WidgetLink.note, object: nil)
    }

    @objc private func onLink(_ n: Notification) {
        guard let url = n.object as? URL else { return }
        WidgetLink.pending = nil
        notifyListeners("link", data: ["url": url.absoluteString], retainUntilConsumed: true)
    }

    @objc func setKey(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty, let url = call.getString("url"), !url.isEmpty else {
            call.reject("key and url are required")
            return
        }
        guard WidgetShared.store(key: key, url: url) else { call.reject("Could not save the widget key to the App Group."); return }
        call.resolve()
    }

    // Reads the FILE, so "Connected" in Settings means exactly what the widgets will see.
    @objc func hasKey(_ call: CAPPluginCall) {
        call.resolve(["has": WidgetShared.hasKey()])
    }

    @objc func clearKey(_ call: CAPPluginCall) {
        WidgetShared.clear()
        call.resolve()
    }

    @objc func reload(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func takeLink(_ call: CAPPluginCall) {
        let url = WidgetLink.pending?.absoluteString ?? ""
        WidgetLink.pending = nil
        call.resolve(["url": url])
    }
}

// The app's root view controller: Capacitor's, plus this app's own plugin.
class BloomBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WidgetBridgePlugin())
    }
}
