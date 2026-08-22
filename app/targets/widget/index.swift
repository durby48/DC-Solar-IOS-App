import SwiftUI
import WidgetKit

// MARK: - Shared state (written by the app via ExtensionStorage)

private let appGroup = "group.com.dcsolarkc.fieldapp"
private let stateKey = "widgetState"

/// Brand colors mirroring src/constants/theme.ts.
private enum Theme {
  static let cream = Color(red: 1.0, green: 0.953, blue: 0.902) // #FFF3E6
  static let sun = Color(red: 1.0, green: 0.690, blue: 0.400) // #FFB066
  static let ocean = Color(red: 0.353, green: 0.659, blue: 0.812) // #5AA8CF
  static let ink = Color(red: 0.239, green: 0.208, blue: 0.180) // #3D352E
  static let inkSoft = Color(red: 0.420, green: 0.365, blue: 0.310) // #6B5D4F
  static let olive = Color(red: 77 / 255, green: 92 / 255, blue: 43 / 255) // #4D5C2B
  static let oliveDeep = Color(red: 58 / 255, green: 70 / 255, blue: 31 / 255) // #3A461F
  static let oliveSoft = Color(red: 231 / 255, green: 237 / 255, blue: 216 / 255) // #E7EDD8
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

@main
struct DCSolarWidgets: WidgetBundle {
  var body: some Widget {
    TodayWidget()
  }
}
