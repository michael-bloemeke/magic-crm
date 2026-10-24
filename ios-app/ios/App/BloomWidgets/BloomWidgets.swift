import WidgetKit
import SwiftUI
import AppIntents

// BLOOM CRM HOME-SCREEN WIDGETS (2026-10-24).
//
// Michael: "I want to just be able to have my CRM data just in view all the time. So that way it's
// always at the front of my brain." Three LARGE widgets, meant to be stacked across a home screen:
//
//   Tasks    every open task: overdue first, then due today, then the rest; inside each, project
//            tasks before general ones. (The order is decided by the server, widget-feed/feed.ts.)
//   Gigs     the next 7 days, soonest first, as the cards from the app's Home "Gigs next 7 days".
//   Mail     unread email FROM anyone on an active project.
//
// Widgets cannot scroll (Apple does not allow it), so each has small up/down buttons that page
// through the list in place, without opening the app (iOS 17 interactive widgets). Tapping a row
// opens that project; tapping anywhere else opens the matching page.
//
// DATA: the widgets fetch https://.../functions/v1/widget-feed with a read-only widget key the app
// stored in the App Group (WidgetBridge.swift). The last good feed is cached there too, so paging is
// instant and a dropped connection shows the last data rather than an error. WidgetKit decides how
// often to refresh; the timeline asks for every 15 minutes, and the app reloads the widgets whenever
// it is opened or changes data.
//
// ⚠️ The App Group id, the defaults keys and the bloomcrm:// links are shared with
// App/WidgetBridge.swift and with app.js. Change one, change all three.

private let appGroup = "group.com.michaelbloemeke.crm"
private var shared: UserDefaults? { UserDefaults(suiteName: appGroup) }

// MARK: - Feed

struct FeedTask: Codable, Hashable { let id: String; let title: String; let projectId: String; let project: String; let due: String; let when: String; let state: String }
struct FeedGig: Codable, Hashable { let id: String; let name: String; let eventType: String; let date: String; let dateLabel: String; let countdown: String; let location: String; let fee: String; let stage: String }
struct FeedMail: Codable, Hashable { let threadId: String; let from: String; let fromEmail: String; let outbound: Bool?; let subject: String; let snippet: String; let ts: Double; let projectId: String; let project: String }
struct TaskCounts: Codable, Hashable { let overdue: Int; let today: Int; let total: Int }
struct NextGig: Codable, Hashable { let id: String; let name: String; let eventType: String; let dateLabel: String; let daysAway: Int; let countdown: String; let location: String; let fee: String; let showTime: String }
struct Money: Codable, Hashable { let monthLabel: String; let yearLabel: String; let monthReceived: Double; let monthEarned: Double; let monthlyGoal: Double; let yearReceived: Double; let yearEarned: Double; let yearGoal: Double }
struct LeadRow: Codable, Hashable { let id: String; let name: String; let eventDate: String }
struct Leads: Codable, Hashable { let count: Int; let latest: [LeadRow] }
struct BookedNext: Codable, Hashable { let id: String; let name: String; let dateLabel: String }
struct Booked: Codable, Hashable { let count: Int; let value: String; let next: BookedNext? }
struct Feed: Codable {
    let generatedAt: String
    let tasks: [FeedTask]
    let taskCounts: TaskCounts
    let gigs: [FeedGig]
    let mail: [FeedMail]
    let mailCount: Int
    let mailError: String?
    // Lock-screen additions (2026-10-24). Optional so a feed cached by an older build still decodes.
    let nextGig: NextGig?
    let finance: Money?
    let leads: Leads?
    let booked: Booked?
}

enum FeedState { case ok, notConnected, rejected, failed }

struct FeedEntry: TimelineEntry {
    let date: Date
    let feed: Feed?
    let state: FeedState
    let fetchedAt: Date?
    let page: Int
}

enum FeedStore {
    // Files in the App Group container, read fresh on every load (2026-10-24). The first build read
    // the key from the shared UserDefaults, and on Michael's phone the widget never once saw the key
    // the app had stored there (cause suspected, not reproduced; see App/WidgetBridge.swift). A file
    // has no per-process cache to go stale. UserDefaults is still read as a fallback.
    static var dir: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) }
    static var cacheFile: URL? { dir?.appendingPathComponent("widget-feed.json") }

    static func credentials() -> (String, URL)? {
        if let file = dir?.appendingPathComponent("widget-key.json"), let data = try? Data(contentsOf: file),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
           let key = obj["key"], !key.isEmpty, let u = obj["url"], let url = URL(string: u) {
            return (key, url)
        }
        if let d = shared, let key = d.string(forKey: "widgetToken"), !key.isEmpty,
           let u = d.string(forKey: "feedURL"), let url = URL(string: u) {
            return (key, url)
        }
        return nil
    }

    static func cached() -> (Feed, Date)? {
        guard let file = cacheFile, let data = try? Data(contentsOf: file),
              let feed = try? JSONDecoder().decode(Feed.self, from: data) else { return nil }
        let at = (try? FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date) ?? nil
        return (feed, at ?? Date.distantPast)
    }

    // Fresh enough to reuse without a network call: this is what makes paging instant.
    static func load(maxAge: TimeInterval = 90) async -> (Feed?, FeedState, Date?) {
        guard let (key, url) = credentials() else { return (nil, .notConnected, nil) }
        if let (feed, at) = cached(), Date().timeIntervalSince(at) < maxAge { return (feed, .ok, at) }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue(key, forHTTPHeaderField: "x-widget-token")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 { return (nil, .rejected, nil) }
            guard code == 200, let feed = try? JSONDecoder().decode(Feed.self, from: data) else {
                if let (f, at) = cached() { return (f, .ok, at) }
                return (nil, .failed, nil)
            }
            if let file = cacheFile { try? data.write(to: file, options: [.atomic]) }
            return (feed, .ok, Date())
        } catch {
            if let (f, at) = cached() { return (f, .ok, at) }
            return (nil, .failed, nil)
        }
    }

    static func page(_ kind: String) -> Int { shared?.integer(forKey: "page.\(kind)") ?? 0 }
}

struct Provider: TimelineProvider {
    let kind: String
    func placeholder(in context: Context) -> FeedEntry { FeedEntry(date: Date(), feed: nil, state: .ok, fetchedAt: nil, page: 0) }
    func getSnapshot(in context: Context, completion: @escaping (FeedEntry) -> Void) {
        Task {
            let (feed, state, at) = await FeedStore.load(maxAge: context.isPreview ? 3600 : 90)
            completion(FeedEntry(date: Date(), feed: feed, state: state, fetchedAt: at, page: FeedStore.page(kind)))
        }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<FeedEntry>) -> Void) {
        Task {
            let (feed, state, at) = await FeedStore.load()
            let entry = FeedEntry(date: Date(), feed: feed, state: state, fetchedAt: at, page: FeedStore.page(kind))
            // Not connected yet, or the network failed: look again in two minutes rather than fifteen,
            // so a missed reload from the app can never strand the widget on a message.
            let wait: TimeInterval = (feed == nil) ? 120 : 15 * 60
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(wait))))
        }
    }
}

// MARK: - Paging (the stand-in for scrolling)

struct SetPageIntent: AppIntent {
    static var title: LocalizedStringResource = "Change page"
    static var isDiscoverable: Bool = false
    @Parameter(title: "Widget") var kind: String
    @Parameter(title: "Page") var page: Int
    init() {}
    init(kind: String, page: Int) { self.kind = kind; self.page = page }
    func perform() async throws -> some IntentResult {
        shared?.set(max(0, page), forKey: "page.\(kind)")
        return .result()
    }
}

// MARK: - Look (the app's navy ground, white cards)

private extension Color {
    init(hex: UInt32) { self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255) }
}
private let navyTop = Color(hex: 0x1D3170)
private let navyBottom = Color(hex: 0x0C1638)
private let gold = Color(hex: 0xE3C279)
private let ink = Color(hex: 0x14171B)
private let muted = Color(hex: 0x545B64)
private let faint = Color(hex: 0x858D97)
private let red = Color(hex: 0xDC2626)
private let amber = Color(hex: 0xB45309)
private let blue = Color(hex: 0x2563EB)
private let soft = Color.white.opacity(0.72)

private func typeColor(_ t: String) -> Color {
    switch t {
    case "Wedding": return Color(hex: 0x2563EB)
    case "Corporate": return Color(hex: 0x15803D)
    case "Private Event": return Color(hex: 0xB7791F)
    case "Bachelor(ette) Party": return Color(hex: 0x64748B)
    default: return Color(hex: 0x858D97)
    }
}

private func link(_ s: String) -> URL { URL(string: s) ?? URL(string: "bloomcrm://home")! }
private func timeLabel(_ d: Date?) -> String {
    guard let d else { return "" }
    let f = DateFormatter(); f.dateFormat = "h:mm a"
    return f.string(from: d)
}

struct WidgetShell<Content: View>: View {
    let title: String
    let subtitle: String
    let updated: Date?
    let kind: String
    let page: Int
    let pages: Int
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 19, weight: .semibold, design: .serif)).foregroundStyle(.white)
                    Text(subtitle).font(.system(size: 11, weight: .medium)).foregroundStyle(soft).lineLimit(1)
                }
                Spacer(minLength: 4)
                if pages > 1 {
                    Text("\(page + 1)/\(pages)").font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(soft)
                    pageButton("chevron.up", to: page - 1, enabled: page > 0)
                    pageButton("chevron.down", to: page + 1, enabled: page < pages - 1)
                }
            }
            content()
            Spacer(minLength: 0)
            if let updated {
                Text("Updated \(timeLabel(updated))").font(.system(size: 9.5, weight: .medium)).foregroundStyle(soft.opacity(0.8))
            }
        }
    }

    private func pageButton(_ icon: String, to: Int, enabled: Bool) -> some View {
        Button(intent: SetPageIntent(kind: kind, page: to)) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(enabled ? navyBottom : navyBottom.opacity(0.35))
                .frame(width: 28, height: 28)
                .background(Circle().fill(enabled ? gold : gold.opacity(0.35)))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

private struct Note: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 14, weight: .medium)).foregroundStyle(soft)
            .multilineTextAlignment(.center).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private func stateNote(_ e: FeedEntry) -> String? {
    if e.feed != nil { return nil }
    switch e.state {
    case .notConnected: return "Open Bloom CRM once to connect this widget."
    case .rejected: return "This widget was disconnected. Open Bloom CRM, then Settings, Notifications, Reconnect."
    case .failed: return "Could not reach the CRM. It will try again shortly."
    case .ok: return "Loading…"
    }
}

// How many rows fit, from the space the widget actually has (iPhone and iPad sizes differ).
// `chrome` is the header plus the "Updated" footer, measured on an iPhone 17 simulator (2026-10-24).
private func fit(_ height: CGFloat, row: CGFloat, spacing: CGFloat, chrome: CGFloat = 70) -> Int {
    max(1, Int((height - chrome + spacing) / (row + spacing)))
}
private func pageOf(_ page: Int, count: Int, per: Int) -> (Int, Int) {
    let pages = max(1, Int(ceil(Double(count) / Double(per))))
    return (min(max(0, page), pages - 1), pages)
}

// MARK: - Tasks

struct TasksView: View {
    let entry: FeedEntry
    var body: some View {
        GeometryReader { geo in
            let tasks = entry.feed?.tasks ?? []
            let per = fit(geo.size.height, row: 33, spacing: 4)
            let (page, pages) = pageOf(entry.page, count: tasks.count, per: per)
            let c = entry.feed?.taskCounts
            WidgetShell(title: "Tasks",
                        subtitle: c.map { "\($0.overdue) overdue · \($0.today) due today · \($0.total) open" } ?? "",
                        updated: entry.fetchedAt, kind: "tasks", page: page, pages: pages) {
                if let note = stateNote(entry) { Note(text: note) }
                else if tasks.isEmpty { Note(text: "All caught up.") }
                else {
                    VStack(spacing: 4) {
                        ForEach(Array(tasks.dropFirst(page * per).prefix(per)), id: \.id) { t in
                            Link(destination: link(t.projectId.isEmpty ? "bloomcrm://tasks" : "bloomcrm://project/\(t.projectId)")) { TaskRow(t: t) }
                        }
                    }
                }
            }
        }
        .widgetURL(link("bloomcrm://tasks"))
    }
}

struct TaskRow: View {
    let t: FeedTask
    var body: some View {
        let dot: Color = t.state == "overdue" ? red : t.state == "today" ? amber : faint
        HStack(spacing: 9) {
            RoundedRectangle(cornerRadius: 2).fill(dot).frame(width: 4, height: 23)
            VStack(alignment: .leading, spacing: 1) {
                Text(t.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(ink).lineLimit(1)
                HStack(spacing: 4) {
                    if !t.when.isEmpty {
                        Text(t.state == "overdue" ? "Overdue · \(t.when)" : t.when).foregroundStyle(t.state == "overdue" ? red : t.state == "today" ? amber : muted)
                    }
                    if !t.project.isEmpty { Text(t.when.isEmpty ? t.project : "· \(t.project)").foregroundStyle(muted) }
                }
                .font(.system(size: 10.5, weight: .medium)).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 9)
        .frame(height: 33)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color.white))
    }
}

// MARK: - Gigs

struct GigsView: View {
    let entry: FeedEntry
    var body: some View {
        GeometryReader { geo in
            let gigs = entry.feed?.gigs ?? []
            let per = fit(geo.size.height, row: 80, spacing: 6)
            let (page, pages) = pageOf(entry.page, count: gigs.count, per: per)
            WidgetShell(title: "Gigs next 7 days",
                        subtitle: gigs.count == 1 ? "1 coming up" : "\(gigs.count) coming up",
                        updated: entry.fetchedAt, kind: "gigs", page: page, pages: pages) {
                if let note = stateNote(entry) { Note(text: note) }
                else if gigs.isEmpty { Note(text: "No gigs in the next 7 days.") }
                else {
                    VStack(spacing: 6) {
                        ForEach(Array(gigs.dropFirst(page * per).prefix(per)), id: \.id) { g in
                            Link(destination: link("bloomcrm://project/\(g.id)")) { GigCard(g: g) }
                        }
                    }
                }
            }
        }
        .widgetURL(link("bloomcrm://gigs"))
    }
}

struct GigCard: View {
    let g: FeedGig
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(g.name).font(.system(size: 15, weight: .semibold, design: .serif)).foregroundStyle(ink).lineLimit(1)
                Spacer(minLength: 6)
                if !g.fee.isEmpty { Text(g.fee).font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(blue) }
            }
            HStack(spacing: 6) {
                Text(g.eventType).font(.system(size: 10, weight: .bold)).foregroundStyle(typeColor(g.eventType))
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(typeColor(g.eventType).opacity(0.12)))
                Text("\(g.dateLabel) · \(g.countdown)").font(.system(size: 11.5, weight: .medium)).foregroundStyle(muted).lineLimit(1)
            }
            HStack(alignment: .center, spacing: 6) {
                Text(g.location).font(.system(size: 11)).foregroundStyle(faint).lineLimit(1)
                Spacer(minLength: 4)
                if !g.stage.isEmpty {
                    Text(g.stage).font(.system(size: 10, weight: .semibold)).foregroundStyle(muted)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .overlay(Capsule().stroke(Color.black.opacity(0.14), lineWidth: 1))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 11).padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: 80, maxHeight: 80, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color.white))
    }
}

// MARK: - Mail

struct MailView: View {
    let entry: FeedEntry
    var body: some View {
        GeometryReader { geo in
            let mail = entry.feed?.mail ?? []
            let per = fit(geo.size.height, row: 60, spacing: 5)
            let (page, pages) = pageOf(entry.page, count: mail.count, per: per)
            WidgetShell(title: "Unread email",
                        subtitle: "\(entry.feed?.mailCount ?? 0) from clients",
                        updated: entry.fetchedAt, kind: "mail", page: page, pages: pages) {
                if let note = stateNote(entry) { Note(text: note) }
                else if mail.isEmpty { Note(text: "No unread email from clients.") }
                else {
                    VStack(spacing: 5) {
                        ForEach(Array(mail.dropFirst(page * per).prefix(per)), id: \.threadId) { m in
                            Link(destination: link(m.projectId.isEmpty ? "bloomcrm://inbox" : "bloomcrm://project/\(m.projectId)/email")) { MailRow(m: m) }
                        }
                    }
                }
            }
        }
        .widgetURL(link("bloomcrm://inbox"))
    }
}

struct MailRow: View {
    let m: FeedMail
    private var when: String {
        let d = Date(timeIntervalSince1970: m.ts / 1000)
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(d) ? "h:mm a" : "MMM d"
        return f.string(from: d)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(blue).frame(width: 7, height: 7)
                // Mail he sent to a client: the row names the client, marked "To", like the app's Inbox.
                if m.outbound == true { Text("To").font(.system(size: 10, weight: .bold)).foregroundStyle(faint) }
                Text(m.from).font(.system(size: 13, weight: .semibold)).foregroundStyle(ink).lineLimit(1)
                if !m.project.isEmpty && m.project != m.from {
                    Text(m.project).font(.system(size: 10.5, weight: .medium)).foregroundStyle(blue).lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(when).font(.system(size: 10.5)).foregroundStyle(faint)
            }
            Text(m.subject).font(.system(size: 12, weight: .medium)).foregroundStyle(ink).lineLimit(1)
            Text(m.snippet).font(.system(size: 11)).foregroundStyle(muted).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 60, maxHeight: 60, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white))
    }
}

// MARK: - The three widgets

private struct Ground: View {
    var body: some View { LinearGradient(colors: [navyTop, navyBottom], startPoint: .top, endPoint: .bottom) }
}

// Every widget below can go on the LOCK SCREEN too (round, rectangular, and the one line above the
// clock); Tasks, Gigs and Unread email are also the large home-screen widgets. One widget, several
// sizes: the view switches on the family it is placed in.
private let lockFamilies: [WidgetFamily] = [.accessoryCircular, .accessoryRectangular, .accessoryInline]

struct TasksEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: FeedEntry
    var body: some View {
        if family == .systemLarge { TasksView(entry: entry).containerBackground(for: .widget) { Ground() } }
        else { LockTasks(entry: entry, family: family).lockBackground(family) }
    }
}
struct GigsEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: FeedEntry
    var body: some View {
        if family == .systemLarge { GigsView(entry: entry).containerBackground(for: .widget) { Ground() } }
        else { LockNextGig(entry: entry, family: family).lockBackground(family) }
    }
}
struct MailEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: FeedEntry
    var body: some View {
        if family == .systemLarge { MailView(entry: entry).containerBackground(for: .widget) { Ground() } }
        else { LockMail(entry: entry, family: family).lockBackground(family) }
    }
}

struct TasksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomTasks", provider: Provider(kind: "tasks")) { e in TasksEntryView(entry: e) }
        .configurationDisplayName("Tasks")
        .description("Overdue first, then due today. Project tasks before general ones.")
        .supportedFamilies([.systemLarge] + lockFamilies)
    }
}

struct GigsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomGigs", provider: Provider(kind: "gigs")) { e in GigsEntryView(entry: e) }
        .configurationDisplayName("Gigs")
        .description("Home screen: the next 7 days of gigs. Lock screen: your next booked gig.")
        .supportedFamilies([.systemLarge] + lockFamilies)
    }
}

struct MailWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomMail", provider: Provider(kind: "mail")) { e in MailEntryView(entry: e) }
        .configurationDisplayName("Unread email")
        .description("Unread email to or from anyone on an active project.")
        .supportedFamilies([.systemLarge] + lockFamilies)
    }
}

struct MoneyMonthWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomMoneyMonth", provider: Provider(kind: "money-month")) { e in
            LockFamily { f in LockMoney(entry: e, year: false, family: f) }
        }
        .configurationDisplayName("Money this month")
        .description("Money received this month against your monthly goal, and money earned.")
        .supportedFamilies(lockFamilies)
    }
}

struct MoneyYearWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomMoneyYear", provider: Provider(kind: "money-year")) { e in
            LockFamily { f in LockMoney(entry: e, year: true, family: f) }
        }
        .configurationDisplayName("Money this year")
        .description("Money received so far this year against your income goal, and money earned.")
        .supportedFamilies(lockFamilies)
    }
}

struct LeadsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomLeads", provider: Provider(kind: "leads")) { e in
            LockFamily { f in LockLeads(entry: e, family: f) }
        }
        .configurationDisplayName("New leads")
        .description("New inquiries still waiting in the Inquiry stage.")
        .supportedFamilies(lockFamilies)
    }
}

struct BookedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BloomBooked", provider: Provider(kind: "booked")) { e in
            LockFamily { f in LockBooked(entry: e, family: f) }
        }
        .configurationDisplayName("Booked")
        .description("Upcoming gigs with money in, and what they are worth.")
        .supportedFamilies(lockFamilies)
    }
}

@main
struct BloomWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TasksWidget()
        GigsWidget()
        MailWidget()
        MoneyMonthWidget()
        MoneyYearWidget()
        LeadsWidget()
        BookedWidget()
    }
}

// MARK: - Lock screen (2026-10-24)
//
// Michael asked for a round and a rectangular lock-screen widget for tasks, gigs and email, plus
// anything else useful (he suggested money this month and this year). Lock-screen widgets are drawn
// by iOS in one tint over the wallpaper, so these use weight and size for emphasis, not colour.
//
// Names and money are marked privacySensitive: iOS hides them while the phone is locked and shows them
// once Face ID recognises him. Counts stay visible either way.

private extension View {
    // The round widgets sit on the standard frosted disc; the others have no background of their own.
    @ViewBuilder func lockBackground(_ family: WidgetFamily) -> some View {
        if family == .accessoryCircular { containerBackground(for: .widget) { AccessoryWidgetBackground() } }
        else { containerBackground(for: .widget) { Color.clear } }
    }
}
// Reads which size the widget was placed at and hands it to the view.
struct LockFamily<Content: View>: View {
    @Environment(\.widgetFamily) var family
    @ViewBuilder let content: (WidgetFamily) -> Content
    var body: some View { content(family).lockBackground(family) }
}

private func compactMoney(_ v: Double) -> String {
    if v >= 1_000_000 { return String(format: "$%.1fM", v / 1_000_000) }
    if v >= 10_000 { return "$\(Int((v / 1000).rounded()))k" }
    if v >= 1_000 { return String(format: "$%.1fk", v / 1000) }
    return "$\(Int(v.rounded()))"
}
private func fullMoney(_ v: Double) -> String {
    let f = NumberFormatter(); f.numberStyle = .decimal; f.maximumFractionDigits = 0
    return "$" + (f.string(from: NSNumber(value: v.rounded())) ?? "\(Int(v))")
}

// A number with a small symbol above it, for the round widgets.
private struct CircleCount: View {
    let symbol: String
    let value: String
    var caption: String = ""
    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
            Text(value).font(.system(size: 22, weight: .bold, design: .rounded)).minimumScaleFactor(0.5).lineLimit(1)
            if !caption.isEmpty { Text(caption).font(.system(size: 10, weight: .medium)) }
        }
    }
}

private struct LockNote: View {
    let entry: FeedEntry
    let family: WidgetFamily
    var body: some View {
        let msg = entry.state == .notConnected ? "Open Bloom CRM" : entry.state == .rejected ? "Reconnect in Settings" : "Loading"
        if family == .accessoryCircular { Image(systemName: "exclamationmark.circle").font(.title3) }
        else { Text(msg).font(.system(size: 13, weight: .medium)) }
    }
}

struct LockTasks: View {
    let entry: FeedEntry
    let family: WidgetFamily
    var body: some View {
        Group {
            if let f = entry.feed {
                let c = f.taskCounts
                let due = c.overdue + c.today
                switch family {
                case .accessoryCircular:
                    CircleCount(symbol: "checklist", value: "\(due)", caption: "due")
                case .accessoryInline:
                    Label("\(c.overdue) overdue · \(c.today) due today", systemImage: "checklist")
                default:
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(c.overdue) overdue · \(c.today) today").font(.system(size: 14, weight: .bold)).widgetAccentable()
                        ForEach(Array(f.tasks.prefix(2)), id: \.id) { t in
                            Text(t.project.isEmpty ? t.title : "\(t.title) · \(t.project)")
                                .font(.system(size: 13)).lineLimit(1).privacySensitive()
                        }
                        if f.tasks.isEmpty { Text("All caught up.").font(.system(size: 13)) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { LockNote(entry: entry, family: family) }
        }
        .widgetURL(URL(string: "bloomcrm://tasks"))
    }
}

struct LockNextGig: View {
    let entry: FeedEntry
    let family: WidgetFamily
    var body: some View {
        let g = entry.feed?.nextGig
        Group {
            if entry.feed == nil { LockNote(entry: entry, family: family) }
            else if let g {
                switch family {
                case .accessoryCircular:
                    VStack(spacing: 0) {
                        Image(systemName: "calendar").font(.system(size: 12, weight: .semibold))
                        if g.daysAway == 0 { Text("Today").font(.system(size: 14, weight: .bold)) }
                        else {
                            Text("\(g.daysAway)").font(.system(size: 22, weight: .bold, design: .rounded)).minimumScaleFactor(0.5)
                            Text(g.daysAway == 1 ? "day" : "days").font(.system(size: 10, weight: .medium))
                        }
                    }
                case .accessoryInline:
                    Label("Next gig: \(g.countdown.lowercased())", systemImage: "calendar")
                default:
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Next gig · \(g.countdown)").font(.system(size: 14, weight: .bold)).widgetAccentable()
                        Text(g.name).font(.system(size: 13, weight: .semibold)).lineLimit(1).privacySensitive()
                        Text(g.showTime.isEmpty ? "\(g.dateLabel) · \(g.location)" : "\(g.dateLabel) · \(g.showTime)")
                            .font(.system(size: 12)).lineLimit(1).privacySensitive()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                switch family {
                case .accessoryCircular: CircleCount(symbol: "calendar", value: "0")
                case .accessoryInline: Label("No booked gigs coming up", systemImage: "calendar")
                default: Text("No booked gigs coming up.").font(.system(size: 13))
                }
            }
        }
        .widgetURL(URL(string: g.map { "bloomcrm://project/\($0.id)" } ?? "bloomcrm://pipeline"))
    }
}

struct LockMail: View {
    let entry: FeedEntry
    let family: WidgetFamily
    var body: some View {
        Group {
            if let f = entry.feed {
                switch family {
                case .accessoryCircular:
                    CircleCount(symbol: "envelope", value: "\(f.mailCount)")
                case .accessoryInline:
                    Label(f.mailCount == 1 ? "1 unread client email" : "\(f.mailCount) unread client emails", systemImage: "envelope")
                default:
                    VStack(alignment: .leading, spacing: 1) {
                        Text(f.mailCount == 1 ? "1 unread email" : "\(f.mailCount) unread emails").font(.system(size: 14, weight: .bold)).widgetAccentable()
                        ForEach(Array(f.mail.prefix(2)), id: \.threadId) { m in
                            Text("\(m.outbound == true ? "To " : "")\(m.from) · \(m.subject)").font(.system(size: 13)).lineLimit(1).privacySensitive()
                        }
                        if f.mail.isEmpty { Text("Nothing unread from clients.").font(.system(size: 13)) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { LockNote(entry: entry, family: family) }
        }
        .widgetURL(URL(string: "bloomcrm://inbox"))
    }
}

struct LockMoney: View {
    let entry: FeedEntry
    let year: Bool
    let family: WidgetFamily
    var body: some View {
        Group {
            if let m = entry.feed?.finance {
                let received = year ? m.yearReceived : m.monthReceived
                let earned = year ? m.yearEarned : m.monthEarned
                let goal = year ? m.yearGoal : m.monthlyGoal
                let label = year ? m.yearLabel : m.monthLabel
                let pct = goal > 0 ? Int((received / goal * 100).rounded()) : 0
                switch family {
                case .accessoryCircular:
                    if goal > 0 {
                        Gauge(value: min(1, received / goal)) {
                            Image(systemName: "dollarsign")
                        } currentValueLabel: {
                            Text(compactMoney(received)).privacySensitive()
                        }
                        .gaugeStyle(.accessoryCircularCapacity)
                    } else { CircleCount(symbol: "dollarsign", value: compactMoney(received)).privacySensitive() }
                case .accessoryInline:
                    Text("\(fullMoney(received)) in \(label)").privacySensitive()
                default:
                    VStack(alignment: .leading, spacing: 1) {
                        Text(year ? "\(label) so far" : label).font(.system(size: 14, weight: .bold)).widgetAccentable()
                        Text("\(fullMoney(received)) received").font(.system(size: 13, weight: .semibold)).privacySensitive()
                        Text(goal > 0 ? "\(pct)% of \(compactMoney(goal)) · \(compactMoney(earned)) earned" : "\(fullMoney(earned)) earned")
                            .font(.system(size: 12)).lineLimit(1).privacySensitive()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if entry.feed == nil { LockNote(entry: entry, family: family) }
            else { Text("Update Bloom CRM").font(.system(size: 12)) }
        }
        .widgetURL(URL(string: "bloomcrm://finance"))
    }
}

struct LockLeads: View {
    let entry: FeedEntry
    let family: WidgetFamily
    var body: some View {
        Group {
            if let l = entry.feed?.leads {
                switch family {
                case .accessoryCircular:
                    CircleCount(symbol: "person.badge.plus", value: "\(l.count)")
                case .accessoryInline:
                    Label(l.count == 1 ? "1 new lead waiting" : "\(l.count) new leads waiting", systemImage: "person.badge.plus")
                default:
                    VStack(alignment: .leading, spacing: 1) {
                        Text(l.count == 1 ? "1 new lead" : "\(l.count) new leads").font(.system(size: 14, weight: .bold)).widgetAccentable()
                        ForEach(Array(l.latest.prefix(2)), id: \.id) { r in
                            Text(r.eventDate.isEmpty ? r.name : "\(r.name) · \(r.eventDate)").font(.system(size: 13)).lineLimit(1).privacySensitive()
                        }
                        if l.latest.isEmpty { Text("None waiting on you.").font(.system(size: 13)) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if entry.feed == nil { LockNote(entry: entry, family: family) }
            else { Text("Update Bloom CRM").font(.system(size: 12)) }
        }
        .widgetURL(URL(string: "bloomcrm://pipeline"))
    }
}

struct LockBooked: View {
    let entry: FeedEntry
    let family: WidgetFamily
    var body: some View {
        Group {
            if let b = entry.feed?.booked {
                switch family {
                case .accessoryCircular:
                    CircleCount(symbol: "checkmark.seal", value: "\(b.count)")
                case .accessoryInline:
                    Label("\(b.count) booked · \(b.value)", systemImage: "checkmark.seal").privacySensitive()
                default:
                    VStack(alignment: .leading, spacing: 1) {
                        Text(b.count == 1 ? "1 gig booked" : "\(b.count) gigs booked").font(.system(size: 14, weight: .bold)).widgetAccentable()
                        Text("\(b.value) on the books").font(.system(size: 13)).privacySensitive()
                        // Date first, so a long name is what gets cut short. "Sat, Nov 14" drops the weekday.
                        if let n = b.next {
                            let day = n.dateLabel.split(separator: ",").dropFirst().joined(separator: ",").trimmingCharacters(in: .whitespaces)
                            Text("Next \(day.isEmpty ? n.dateLabel : day) · \(n.name)").font(.system(size: 12)).lineLimit(1).privacySensitive()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if entry.feed == nil { LockNote(entry: entry, family: family) }
            else { Text("Update Bloom CRM").font(.system(size: 12)) }
        }
        .widgetURL(URL(string: "bloomcrm://pipeline"))
    }
}
