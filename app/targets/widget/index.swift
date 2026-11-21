import SwiftUI
import WidgetKit

// MARK: - Shared state (written by the app via ExtensionStorage)

private let appGroup = "group.com.dcsolarkc.fieldapp"
private let stateKey = "widgetState"

/// Brand colors mirroring src/constants/theme.ts — the 2026-09-12 "Sonoran
/// dusk" dark palette. `cream` is the widget ground and is the app's CARD
/// charcoal (not the page), so the widget matches a card on the Home screen.
private enum Theme {
  static let cream = Color(red: 42 / 255, green: 38 / 255, blue: 35 / 255) // #2A2623
  static let sun = Color(red: 216 / 255, green: 185 / 255, blue: 138 / 255) // #D8B98A
  static let ocean = Color(red: 141 / 255, green: 169 / 255, blue: 189 / 255) // #8DA9BD
  static let ink = Color(red: 239 / 255, green: 231 / 255, blue: 220 / 255) // #EFE7DC
  static let inkSoft = Color(red: 184 / 255, green: 173 / 255, blue: 159 / 255) // #B8AD9F
  static let olive = Color(red: 169 / 255, green: 184 / 255, blue: 148 / 255) // #A9B894
  static let oliveDeep = Color(red: 196 / 255, green: 208 / 255, blue: 179 / 255) // #C4D0B3
  static let oliveSoft = Color(red: 46 / 255, green: 58 / 255, blue: 43 / 255) // #2E3A2B
}

struct WidgetState {
  var jobName: String
  var jobNumber: String
  var address: String
  /// Clock-in time in ms since epoch; 0 when off the clock.
  var clockInAt: Double
  /// Seconds already worked today across completed punches.
  var todaySeconds: Double

  var isClockedIn: Bool { clockInAt > 0 }
  var hasJob: Bool { !jobName.isEmpty || !jobNumber.isEmpty }

  /// Start date for a live "total time today" timer: the current punch's
  /// clock-in shifted back by time already worked today.
  var timerStart: Date {
    Date(timeIntervalSince1970: clockInAt / 1000 - todaySeconds)
  }

  static func load() -> WidgetState {
    let dict = UserDefaults(suiteName: appGroup)?.dictionary(forKey: stateKey) ?? [:]
    func str(_ key: String) -> String { dict[key] as? String ?? "" }
    func num(_ key: String) -> Double { (dict[key] as? NSNumber)?.doubleValue ?? 0 }
    return WidgetState(
      jobName: str("jobName"),
      jobNumber: str("jobNumber"),
      address: str("address"),
      clockInAt: num("clockInAt"),
      todaySeconds: num("todaySeconds")
    )
  }
}

// MARK: - Timeline

struct TodayEntry: TimelineEntry {
  let date: Date
  let state: WidgetState
}

struct TodayProvider: TimelineProvider {
  func placeholder(in context: Context) -> TodayEntry {
    TodayEntry(
      date: Date(),
      state: WidgetState(
        jobName: "Smith Residence",
        jobNumber: "DC-26018",
        address: "123 Main St, Kansas City",
        clockInAt: 0,
        todaySeconds: 0
      )
    )
  }

  func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
    completion(TodayEntry(date: Date(), state: WidgetState.load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
    let entry = TodayEntry(date: Date(), state: WidgetState.load())
    // The app pushes fresh data on every open/punch; roll over at midnight so
    // yesterday's job doesn't linger.
    let midnight = Calendar.current.startOfDay(
      for: Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    )
    completion(Timeline(entries: [entry], policy: .after(midnight)))
  }
}

// MARK: - Views

struct ClockRow: View {
  let state: WidgetState

  private func hoursLabel(_ seconds: Double) -> String {
    let total = Int(seconds)
    let h = total / 3600
    let m = (total % 3600) / 60
    return h > 0 ? "\(h)h \(m)m today" : "\(m)m today"
  }

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(state.isClockedIn ? Theme.olive : Theme.inkSoft.opacity(0.45))
        .frame(width: 7, height: 7)
      if state.isClockedIn {
        Text(state.timerStart, style: .timer)
          .font(.system(.subheadline, design: .rounded).weight(.bold).monospacedDigit())
          .foregroundStyle(Theme.ink)
      } else if state.todaySeconds > 0 {
        Text(hoursLabel(state.todaySeconds))
          .font(.system(.subheadline, design: .rounded).weight(.bold))
          .foregroundStyle(Theme.ink)
      } else {
        Text("Off the clock")
          .font(.system(.footnote, design: .rounded).weight(.semibold))
          .foregroundStyle(Theme.inkSoft)
      }
    }
  }
}

struct TodayWidgetView: View {
  var entry: TodayEntry
  @Environment(\.widgetFamily) private var family

  private var state: WidgetState { entry.state }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 4) {
        Circle().fill(Theme.sun).frame(width: 8, height: 8)
        Text("TODAY’S JOB")
          .font(.system(size: 10, weight: .heavy, design: .rounded))
          .foregroundStyle(Theme.inkSoft)
          .kerning(0.6)
        Spacer(minLength: 0)
        if family != .systemSmall && !state.jobNumber.isEmpty {
          Text(state.jobNumber)
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .foregroundStyle(Theme.ocean)
        }
      }

      if state.hasJob {
        Text(state.jobName.isEmpty ? state.jobNumber : state.jobName)
          .font(.system(.headline, design: .rounded).weight(.bold))
          .foregroundStyle(Theme.ink)
          .lineLimit(family == .systemSmall ? 2 : 1)
          .minimumScaleFactor(0.8)
        if !state.address.isEmpty {
          Text(state.address)
            .font(.system(.caption, design: .rounded).weight(.medium))
            .foregroundStyle(Theme.inkSoft)
            .lineLimit(family == .systemSmall ? 1 : 2)
        }
      } else {
        Text("No job scheduled")
          .font(.system(.headline, design: .rounded).weight(.bold))
          .foregroundStyle(Theme.inkSoft)
      }

      Spacer(minLength: 2)
      ClockRow(state: state)
    }
    .containerBackground(Theme.cream, for: .widget)
    .widgetURL(URL(string: "dcsolarkc://"))
  }
}

// MARK: - Widget

struct TodayWidget: Widget {
  let kind = "DCSolarTodayWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: TodayProvider()) { entry in
      TodayWidgetView(entry: entry)
    }
    .configurationDisplayName("Today’s Job")
    .description("Today’s job, address, and your time on the clock.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}


// MARK: - Company numbers (2026-11-21): YTD revenue + company value

private let financeKey = "financeState"

/// Written by the app (src/lib/financeWidget.ts) from QuickBooks — admins' phones only.
struct FinanceState {
  var ytdRevenue: Double
  var companyValue: Double
  var year: Int
  /// ms since epoch the numbers were read; 0 = nothing on this phone.
  var asOf: Double

  var hasData: Bool { asOf > 0 }
  var asOfDate: Date { Date(timeIntervalSince1970: asOf / 1000) }

  static func load() -> FinanceState {
    let dict = UserDefaults(suiteName: appGroup)?.dictionary(forKey: financeKey) ?? [:]
    func num(_ key: String) -> Double { (dict[key] as? NSNumber)?.doubleValue ?? 0 }
    return FinanceState(
      ytdRevenue: num("ytdRevenue"),
      companyValue: num("companyValue"),
      year: Int(num("year")),
      asOf: num("asOf")
    )
  }
}

struct FinanceEntry: TimelineEntry {
  let date: Date
  let state: FinanceState
}

struct FinanceProvider: TimelineProvider {
  func placeholder(in context: Context) -> FinanceEntry {
    FinanceEntry(date: Date(), state: FinanceState(ytdRevenue: 255_980, companyValue: 49_202, year: 2026, asOf: Date().timeIntervalSince1970 * 1000))
  }

  func getSnapshot(in context: Context, completion: @escaping (FinanceEntry) -> Void) {
    let state = FinanceState.load()
    completion(FinanceEntry(date: Date(), state: state.hasData ? state : placeholder(in: context).state))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<FinanceEntry>) -> Void) {
    // The numbers only change when the app writes new ones (and asks WidgetKit
    // to reload); the hourly tick just keeps the "updated … ago" line honest.
    let entry = FinanceEntry(date: Date(), state: FinanceState.load())
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(3600))))
  }
}

private func dollars(_ value: Double) -> String {
  let f = NumberFormatter()
  f.numberStyle = .currency
  f.currencyCode = "USD"
  f.maximumFractionDigits = 0
  return f.string(from: NSNumber(value: value)) ?? "$\(Int(value))"
}

struct FinanceFigure: View {
  let label: String
  let value: Double
  let color: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(label)
        .font(.system(size: 10, weight: .heavy, design: .rounded))
        .foregroundStyle(Theme.inkSoft)
        .kerning(0.5)
        .lineLimit(1)
      Text(dollars(value))
        .font(.system(.title3, design: .rounded).weight(.bold).monospacedDigit())
        .foregroundStyle(color)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
    }
  }
}

struct FinanceWidgetView: View {
  var entry: FinanceEntry
  @Environment(\.widgetFamily) private var family

  private var state: FinanceState { entry.state }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 4) {
        Circle().fill(Theme.olive).frame(width: 8, height: 8)
        Text("DC SOLAR")
          .font(.system(size: 10, weight: .heavy, design: .rounded))
          .foregroundStyle(Theme.inkSoft)
          .kerning(0.6)
        Spacer(minLength: 0)
      }

      if state.hasData {
        if family == .systemMedium {
          HStack(alignment: .top, spacing: 12) {
            FinanceFigure(label: "\(state.year) REVENUE", value: state.ytdRevenue, color: Theme.sun)
            Spacer(minLength: 0)
            FinanceFigure(label: "COMPANY VALUE", value: state.companyValue, color: Theme.oliveDeep)
          }
        } else {
          FinanceFigure(label: "\(state.year) REVENUE", value: state.ytdRevenue, color: Theme.sun)
          FinanceFigure(label: "COMPANY VALUE", value: state.companyValue, color: Theme.oliveDeep)
        }
        Spacer(minLength: 0)
        HStack(spacing: 3) {
          Text("QuickBooks ·")
          Text(state.asOfDate, style: .relative)
          Text("ago")
        }
        .font(.system(size: 9, weight: .semibold, design: .rounded))
        .foregroundStyle(Theme.inkSoft.opacity(0.8))
        .lineLimit(1)
      } else {
        Spacer(minLength: 0)
        Text("Open DC Solar to load the company numbers")
          .font(.system(.caption, design: .rounded).weight(.semibold))
          .foregroundStyle(Theme.inkSoft)
        Spacer(minLength: 0)
      }
    }
    .containerBackground(Theme.cream, for: .widget)
    .widgetURL(URL(string: "dcsolarkc://financials"))
  }
}

struct FinanceWidget: Widget {
  let kind = "DCSolarFinanceWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: FinanceProvider()) { entry in
      FinanceWidgetView(entry: entry)
    }
    .configurationDisplayName("Company Numbers")
    .description("Year-to-date revenue and company value from QuickBooks. Admins only.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

@main
struct DCSolarWidgets: WidgetBundle {
  var body: some Widget {
    TodayWidget()
    FinanceWidget()
  }
}
