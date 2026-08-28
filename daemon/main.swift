// QuickKey hotkey daemon.
//
// Premiere cannot bind a key to a plugin, and a CEP panel only receives keystrokes
// while it has focus — useless when the editor's hands are in the timeline. So key
// capture lives out here at the OS level and hands the work to the panel, which is
// the only place that can see project state.
//
// Carbon's RegisterEventHotKey is used rather than an event tap: it needs no
// Accessibility permission, and it only claims the combos actually bound — every
// other key reaches Premiere untouched.
//
// The daemon is deliberately dumb. Bindings carry their own ExtendScript, so new
// commands ship by editing quickkey.json; this binary never needs rebuilding.

import Cocoa
import Carbon

setvbuf(stdout, nil, _IONBF, 0)

let home = FileManager.default.homeDirectoryForCurrentUser.path
// Must match the panel, which derives this from CEP's userData path.
let root = "\(home)/Library/Application Support/QuickKey"
let bridgeRequest = "\(root)/bridge/request.json"
let configPath = "\(root)/quickkey.json"
let logPath = "\(root)/bridge/daemon.log"

func logLine(_ msg: String) {
    let line = msg + "\n"
    if let fh = FileHandle(forWritingAtPath: logPath) {
        fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); fh.closeFile()
    } else {
        try? line.write(toFile: logPath, atomically: true, encoding: .utf8)
    }
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

struct Binding { let key: String, mods: [String], label: String, script: String }

let keyCodes: [String: UInt32] = [
    "A": 0x00, "S": 0x01, "D": 0x02, "F": 0x03, "H": 0x04, "G": 0x05, "Z": 0x06,
    "X": 0x07, "C": 0x08, "V": 0x09, "B": 0x0B, "Q": 0x0C, "W": 0x0D, "E": 0x0E,
    "R": 0x0F, "Y": 0x10, "T": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D, "O": 0x1F,
    "U": 0x20, "I": 0x22, "P": 0x23, "L": 0x25, "J": 0x26, "K": 0x28, "N": 0x2D,
    "M": 0x2E, "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60,
    "F6": 0x61, "F7": 0x62, "F8": 0x64, "`": 0x32, "-": 0x1B, "=": 0x18,
    "[": 0x21, "]": 0x1E, ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C
]

func carbonMods(_ mods: [String]) -> UInt32 {
    var m: UInt32 = 0
    for x in mods {
        switch x.lowercased() {
        case "cmd", "command": m |= UInt32(cmdKey)
        case "opt", "alt", "option": m |= UInt32(optionKey)
        case "ctrl", "control": m |= UInt32(controlKey)
        case "shift": m |= UInt32(shiftKey)
        default: break
        }
    }
    return m
}

var frontmostGate: String? = nil
var registry: [UInt32: Binding] = [:]
var refs: [EventHotKeyRef?] = []
var nextID: UInt32 = 1

func jsonString(_ s: String) -> String {
    let d = try! JSONSerialization.data(withJSONObject: [s], options: [])
    var t = String(data: d, encoding: .utf8)!
    t.removeFirst(); t.removeLast()
    return t
}

func send(_ b: Binding) {
    if let gate = frontmostGate,
       NSWorkspace.shared.frontmostApplication?.bundleIdentifier != gate {
        logLine("  (ignored — Premiere not frontmost)")
        return
    }
    let payload: [String: String] = [
        "id": String(Int(Date().timeIntervalSince1970 * 1_000_000)),
        "code": b.script
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    try? data.write(to: URL(fileURLWithPath: bridgeRequest))
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    logLine("\(f.string(from: Date()))  \(b.label)")
}

func unregisterAll() {
    for r in refs where r != nil { UnregisterEventHotKey(r!) }
    refs.removeAll(); registry.removeAll(); nextID = 1
}

func loadAndRegister() {
    unregisterAll()
    guard let data = FileManager.default.contents(atPath: configPath),
          let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { logLine("!! cannot read quickkey.json"); return }

    frontmostGate = json["onlyWhenFrontmost"] as? String
    let raw = json["bindings"] as? [[String: Any]] ?? []

    var live = 0
    for b in raw {
        guard let k = (b["key"] as? String)?.uppercased(),
              let script = b["script"] as? String, !k.isEmpty else { continue }
        guard let code = keyCodes[k] else { logLine("  !! unknown key '\(k)'"); continue }
        let mods = b["mods"] as? [String] ?? []
        let bind = Binding(key: k, mods: mods,
                           label: b["label"] as? String ?? k, script: script)
        var ref: EventHotKeyRef?
        let hkID = EventHotKeyID(signature: OSType(0x514B4559), id: nextID) // 'QKEY'
        if RegisterEventHotKey(code, carbonMods(mods), hkID,
                               GetApplicationEventTarget(), 0, &ref) == noErr {
            registry[nextID] = bind; refs.append(ref); live += 1
        } else {
            logLine("  !! '\(k)' rejected — already claimed by another app")
        }
        nextID += 1
    }
    logLine("bindings live: \(live)")
}

var handler: EventHandlerRef?
var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                         eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
    var hkID = EventHotKeyID()
    GetEventParameter(event, EventParamName(kEventParamDirectObject),
                      EventParamType(typeEventHotKeyID), nil,
                      MemoryLayout<EventHotKeyID>.size, nil, &hkID)
    if let b = registry[hkID.id] { send(b) }
    return noErr
}, 1, &spec, nil, &handler)

try? FileManager.default.createDirectory(atPath: "\(root)/bridge",
                                        withIntermediateDirectories: true)
logLine("QuickKey daemon up")
loadAndRegister()

// Re-read the config when the panel rewrites it, so reassigning a key in the UI
// takes effect immediately rather than on restart.
var lastStamp = (try? FileManager.default.attributesOfItem(atPath: configPath)[.modificationDate] as? Date) ?? nil
Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
    let now = (try? FileManager.default.attributesOfItem(atPath: configPath)[.modificationDate] as? Date) ?? nil
    if now != lastStamp { lastStamp = now; logLine("config changed — reloading"); loadAndRegister() }
}

// Carbon hotkeys arrive through the Cocoa event loop, not a bare RunLoop.
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.accessory)
nsApp.run()
