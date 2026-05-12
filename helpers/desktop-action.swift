import AppKit
import ApplicationServices
import Foundation

// Desktop interaction helper for Samuel.
// Uses CGEvent for mouse/keyboard and AXUIElement for structured element pressing.
//
// Usage:
//   desktop-action click X Y
//   desktop-action double-click X Y
//   desktop-action right-click X Y
//   desktop-action type "text to type"
//   desktop-action key KEYNAME [--modifiers cmd,shift,opt,ctrl]
//   desktop-action scroll up|down|left|right [AMOUNT]
//   desktop-action focus "App Name"
//   desktop-action press-element "App Name" "element description"

// MARK: - Mouse Actions

func mouseClick(x: Double, y: Double, button: CGMouseButton = .left, clickCount: Int = 1) {
    let point = CGPoint(x: x, y: y)

    let downType: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
    let upType: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp

    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
          let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
    else {
        fputs("ERROR: Failed to create mouse events\n", stderr)
        exit(1)
    }

    down.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))

    down.post(tap: .cghidEventTap)
    usleep(50_000) // 50ms between down and up
    up.post(tap: .cghidEventTap)

    if clickCount == 2 {
        // For double-click, send a second pair
        usleep(50_000)
        down.setIntegerValueField(.mouseEventClickState, value: 2)
        up.setIntegerValueField(.mouseEventClickState, value: 2)
        down.post(tap: .cghidEventTap)
        usleep(50_000)
        up.post(tap: .cghidEventTap)
    }
}

// MARK: - Keyboard Actions

let KEY_MAP: [String: UInt16] = [
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "space": 0x31,
    "delete": 0x33, "backspace": 0x33,
    "escape": 0x35, "esc": 0x35,
    "left": 0x7B, "right": 0x7C,
    "down": 0x7D, "up": 0x7E,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "home": 0x73, "end": 0x77,
    "pageup": 0x74, "pagedown": 0x79,
    "forwarddelete": 0x75,
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02,
    "e": 0x0E, "f": 0x03, "g": 0x05, "h": 0x04,
    "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25,
    "m": 0x2E, "n": 0x2D, "o": 0x1F, "p": 0x23,
    "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11,
    "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07,
    "y": 0x10, "z": 0x06,
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14,
    "4": 0x15, "5": 0x17, "6": 0x16, "7": 0x1A,
    "8": 0x1C, "9": 0x19,
    "minus": 0x1B, "equal": 0x18,
    "leftbracket": 0x21, "rightbracket": 0x1E,
    "semicolon": 0x29, "quote": 0x27,
    "comma": 0x2B, "period": 0x2F, "slash": 0x2C,
    "backslash": 0x2A, "grave": 0x32,
]

func pressKey(keyName: String, modifiers: Set<String> = []) {
    let lower = keyName.lowercased()
    guard let keyCode = KEY_MAP[lower] else {
        fputs("ERROR: Unknown key '\(keyName)'. Known keys: \(KEY_MAP.keys.sorted().joined(separator: ", "))\n", stderr)
        exit(1)
    }

    var flags: CGEventFlags = []
    if modifiers.contains("cmd") || modifiers.contains("command") { flags.insert(.maskCommand) }
    if modifiers.contains("shift") { flags.insert(.maskShift) }
    if modifiers.contains("opt") || modifiers.contains("option") || modifiers.contains("alt") { flags.insert(.maskAlternate) }
    if modifiers.contains("ctrl") || modifiers.contains("control") { flags.insert(.maskControl) }

    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    else {
        fputs("ERROR: Failed to create keyboard events\n", stderr)
        exit(1)
    }

    down.flags = flags
    up.flags = flags

    down.post(tap: .cghidEventTap)
    usleep(30_000)
    up.post(tap: .cghidEventTap)
}

// Type text using pasteboard + Cmd+V (reliable for all Unicode)
func typeText(_ text: String) {
    let pasteboard = NSPasteboard.general
    let oldContents = pasteboard.string(forType: .string)

    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)

    usleep(50_000) // let pasteboard settle
    pressKey(keyName: "v", modifiers: ["cmd"])
    usleep(100_000) // let paste complete

    // Restore previous clipboard after a delay
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        pasteboard.clearContents()
        if let old = oldContents {
            pasteboard.setString(old, forType: .string)
        }
    }
}

// MARK: - Scroll

func scroll(direction: String, amount: Int32 = 3) {
    var deltaY: Int32 = 0
    var deltaX: Int32 = 0

    switch direction.lowercased() {
    case "up": deltaY = amount
    case "down": deltaY = -amount
    case "left": deltaX = amount
    case "right": deltaX = -amount
    default:
        fputs("ERROR: Unknown scroll direction '\(direction)'. Use: up, down, left, right\n", stderr)
        exit(1)
    }

    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
        fputs("ERROR: Failed to create scroll event\n", stderr)
        exit(1)
    }
    event.post(tap: CGEventTapLocation.cghidEventTap)
}

// MARK: - Focus App

func focusApp(_ name: String) -> Bool {
    let workspace = NSWorkspace.shared
    for app in workspace.runningApplications {
        guard let appName = app.localizedName else { continue }
        if appName.localizedCaseInsensitiveContains(name) {
            app.activate()
            return true
        }
    }
    return false
}

// MARK: - Press AX Element (click by description)

func getStringAttr(_ element: AXUIElement, _ attr: String) -> String? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard result == .success, let str = value as? String, !str.isEmpty else { return nil }
    return str
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as String as CFString, &value)
    guard result == .success, let children = value as? [AXUIElement] else { return [] }
    return children
}

func getPosition(_ element: AXUIElement) -> CGPoint? {
    var posValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as String as CFString, &posValue)
    guard result == .success else { return nil }
    var point = CGPoint.zero
    if AXValueGetValue(posValue as! AXValue, .cgPoint, &point) {
        return point
    }
    return nil
}

func getSize(_ element: AXUIElement) -> CGSize? {
    var sizeValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as String as CFString, &sizeValue)
    guard result == .success else { return nil }
    var size = CGSize.zero
    if AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) {
        return size
    }
    return nil
}

// Find and press an AX element by matching its description against title/role/description
func pressElement(appName: String, description: String) -> Bool {
    guard let (pid, _) = findApp(appName) else {
        fputs("ERROR: App not found: \(appName)\n", stderr)
        return false
    }

    let appRef = AXUIElementCreateApplication(pid)
    let lowerDesc = description.lowercased()
    var found = false

    // BFS through the AX tree to find matching element
    var queue: [AXUIElement] = [appRef]
    var visited = 0
    let maxVisit = 3000
    let startTime = Date()

    while !queue.isEmpty && visited < maxVisit && Date().timeIntervalSince(startTime) < 5.0 {
        let element = queue.removeFirst()
        visited += 1

        let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""
        let title = getStringAttr(element, kAXTitleAttribute as String) ?? ""
        let desc = getStringAttr(element, kAXDescriptionAttribute as String) ?? ""
        let value = getStringAttr(element, kAXValueAttribute as String) ?? ""

        let combined = "\(role) \(title) \(desc) \(value)".lowercased()

        if combined.contains(lowerDesc) || title.lowercased().contains(lowerDesc) || desc.lowercased().contains(lowerDesc) {
            // Try AXPress action first (most reliable for buttons/links)
            let pressResult = AXUIElementPerformAction(element, kAXPressAction as CFString)
            if pressResult == .success {
                print("OK: Pressed element via AX action — \(role): \(title.isEmpty ? desc : title)")
                found = true
                break
            }

            // Fallback: click at element center coordinates
            if let pos = getPosition(element), let size = getSize(element) {
                let centerX = pos.x + size.width / 2
                let centerY = pos.y + size.height / 2
                mouseClick(x: Double(centerX), y: Double(centerY))
                print("OK: Clicked element at (\(Int(centerX)), \(Int(centerY))) — \(role): \(title.isEmpty ? desc : title)")
                found = true
                break
            }
        }

        for child in getChildren(element) {
            queue.append(child)
        }
    }

    return found
}

// MARK: - Frontmost App / User Activity

// Returns the localized name of the currently frontmost app (the one
// receiving keyboard input). Used by the focus guard to make sure the
// FALLBACK desktop_* path isn't about to send keystrokes into the wrong
// window because the user moved on.
func frontmostApp() -> String? {
    return NSWorkspace.shared.frontmostApplication?.localizedName
}

// Seconds since the user last touched mouse, keys, or moved the pointer.
// Combines keyDown / mouseMoved / leftMouseDown — that covers the cases we
// care about (typing, clicking, navigating). Wheel-only / trackpad-gesture
// activity may be ignored, which is acceptable; we only use this to decide
// whether to give a takeover preamble.
func secondsSinceLastUserInput() -> Double {
    let stateID = CGEventSourceStateID.combinedSessionState
    let keyDown = CGEventSource.secondsSinceLastEventType(stateID, eventType: .keyDown)
    let mouseMoved = CGEventSource.secondsSinceLastEventType(stateID, eventType: .mouseMoved)
    let mouseClick = CGEventSource.secondsSinceLastEventType(stateID, eventType: .leftMouseDown)
    return min(keyDown, mouseMoved, mouseClick)
}

// MARK: - AX Type (programmatic value-set, no keyboard takeover)

// Returns:
//   0 = ok
//   1 = app not found
//   2 = element not found
//   3 = AXSetValue rejected by the app (some Electron / web fields refuse)
func setValueOnElement(appName: String, description: String, text: String) -> Int {
    guard let (pid, _) = findApp(appName) else {
        return 1
    }

    let appRef = AXUIElementCreateApplication(pid)
    let lowerDesc = description.lowercased()

    var queue: [AXUIElement] = [appRef]
    var visited = 0
    let maxVisit = 3000
    let startTime = Date()

    while !queue.isEmpty && visited < maxVisit && Date().timeIntervalSince(startTime) < 5.0 {
        let element = queue.removeFirst()
        visited += 1

        let role = getStringAttr(element, kAXRoleAttribute as String) ?? ""
        let title = getStringAttr(element, kAXTitleAttribute as String) ?? ""
        let desc = getStringAttr(element, kAXDescriptionAttribute as String) ?? ""
        let placeholder = getStringAttr(element, kAXPlaceholderValueAttribute as String) ?? ""

        // Only target text-acceptable roles. Skip read-only displays,
        // buttons, etc., even if their label happens to match.
        let isTextRole = role == (kAXTextFieldRole as String)
            || role == (kAXTextAreaRole as String)
            || role == (kAXComboBoxRole as String)
            || role == "AXSearchField"

        let labelMatch = title.lowercased().contains(lowerDesc)
            || desc.lowercased().contains(lowerDesc)
            || placeholder.lowercased().contains(lowerDesc)

        if isTextRole && labelMatch {
            let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
            if result == .success {
                print("OK: AXSetValue on \(role) — \(title.isEmpty ? (desc.isEmpty ? placeholder : desc) : title)")
                return 0
            }
            // Try focusing first, then re-set — some apps require focus
            _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let retry = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
            if retry == .success {
                print("OK: AXSetValue on \(role) (after focus) — \(title.isEmpty ? (desc.isEmpty ? placeholder : desc) : title)")
                return 0
            }
            return 3
        }

        for child in getChildren(element) {
            queue.append(child)
        }
    }
    return 2
}

func findApp(_ name: String) -> (pid_t, String)? {
    let workspace = NSWorkspace.shared
    for app in workspace.runningApplications {
        guard let appName = app.localizedName else { continue }
        if appName.localizedCaseInsensitiveContains(name) {
            return (app.processIdentifier, appName)
        }
    }
    return nil
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())

guard !args.isEmpty else {
    fputs("Usage: desktop-action <command> [args...]\n", stderr)
    fputs("Commands: click, double-click, right-click, type, key, scroll, focus, press-element\n", stderr)
    exit(1)
}

let command = args[0].lowercased()

switch command {
case "click":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fputs("Usage: desktop-action click X Y\n", stderr)
        exit(1)
    }
    mouseClick(x: x, y: y)
    print("OK: Clicked at (\(Int(x)), \(Int(y)))")

case "double-click":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fputs("Usage: desktop-action double-click X Y\n", stderr)
        exit(1)
    }
    mouseClick(x: x, y: y, clickCount: 2)
    print("OK: Double-clicked at (\(Int(x)), \(Int(y)))")

case "right-click":
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
        fputs("Usage: desktop-action right-click X Y\n", stderr)
        exit(1)
    }
    mouseClick(x: x, y: y, button: .right)
    print("OK: Right-clicked at (\(Int(x)), \(Int(y)))")

case "type":
    guard args.count >= 2 else {
        fputs("Usage: desktop-action type \"text\"\n", stderr)
        exit(1)
    }
    let text = args[1...].joined(separator: " ")
    typeText(text)
    // RunLoop needed for the clipboard restore async dispatch
    RunLoop.current.run(until: Date().addingTimeInterval(1.0))
    print("OK: Typed \(text.count) characters")

case "key":
    guard args.count >= 2 else {
        fputs("Usage: desktop-action key KEYNAME [--modifiers cmd,shift,opt,ctrl]\n", stderr)
        exit(1)
    }
    let keyName = args[1]
    var modifiers: Set<String> = []
    if let modIdx = args.firstIndex(of: "--modifiers"), modIdx + 1 < args.count {
        modifiers = Set(args[modIdx + 1].split(separator: ",").map { String($0).lowercased() })
    }
    pressKey(keyName: keyName, modifiers: modifiers)
    let modStr = modifiers.isEmpty ? "" : " (modifiers: \(modifiers.sorted().joined(separator: "+")))"
    print("OK: Pressed key '\(keyName)'\(modStr)")

case "scroll":
    guard args.count >= 2 else {
        fputs("Usage: desktop-action scroll up|down|left|right [amount]\n", stderr)
        exit(1)
    }
    let direction = args[1]
    let amount: Int32 = args.count >= 3 ? (Int32(args[2]) ?? 3) : 3
    scroll(direction: direction, amount: amount)
    print("OK: Scrolled \(direction) by \(amount)")

case "focus":
    guard args.count >= 2 else {
        fputs("Usage: desktop-action focus \"App Name\"\n", stderr)
        exit(1)
    }
    let appName = args[1...].joined(separator: " ")
    if focusApp(appName) {
        print("OK: Focused \(appName)")
    } else {
        fputs("ERROR: App not found: \(appName)\n", stderr)
        exit(1)
    }

case "press-element":
    guard args.count >= 3 else {
        fputs("Usage: desktop-action press-element \"App Name\" \"element description\"\n", stderr)
        exit(1)
    }
    let appName = args[1]
    let elementDesc = args[2...].joined(separator: " ")
    if pressElement(appName: appName, description: elementDesc) {
        // already printed
    } else {
        print("NOT_FOUND: No matching element for '\(elementDesc)' in \(appName)")
        exit(1)
    }

case "frontmost-app":
    if let name = frontmostApp() {
        print(name)
    } else {
        print("UNKNOWN")
        exit(1)
    }

case "user-activity":
    let secs = secondsSinceLastUserInput()
    // Print a single integer (seconds) — Swift double formatting keeps it simple.
    print(String(format: "%.1f", secs))

case "ax-type":
    guard args.count >= 4 else {
        fputs("Usage: desktop-action ax-type \"App Name\" \"element description\" \"text\"\n", stderr)
        exit(1)
    }
    let appName = args[1]
    let elementDesc = args[2]
    let text = args[3...].joined(separator: " ")
    let code = setValueOnElement(appName: appName, description: elementDesc, text: text)
    switch code {
    case 0:
        // already printed OK above
        break
    case 1:
        print("APP_NOT_FOUND: \(appName)")
        exit(1)
    case 2:
        print("NOT_FOUND: No text field matching '\(elementDesc)' in \(appName)")
        exit(1)
    case 3:
        print("REJECTED: AXSetValue refused by \(appName) (likely Electron / web field that needs real keystrokes)")
        exit(1)
    default:
        print("ERROR: Unknown ax-type result code \(code)")
        exit(1)
    }

default:
    fputs("ERROR: Unknown command '\(command)'\n", stderr)
    fputs("Commands: click, double-click, right-click, type, key, scroll, focus, press-element, ax-type, frontmost-app, user-activity\n", stderr)
    exit(1)
}
