# QuickKey

A command layer for Adobe Premiere Pro. One keystroke applies an effect —
your effect, with your settings — to whatever clip is selected.

Premiere makes you travel to a panel to perform an action, so every intent
becomes a sequence of trips. Applying a blur is roughly seven actions. QuickKey
makes it one.

## Why it needs four moving parts

Premiere blocks this in two separate ways, and each needs its own answer.

| Piece | Why it exists |
|---|---|
| `daemon/` | Premiere cannot bind a key to a plugin, and a panel only receives keys while focused — useless mid-edit. So key capture happens at the OS level. Carbon `RegisterEventHotKey`, which needs no Accessibility permission. |
| bridge | A file the daemon writes and the panel watches. Also the dev harness — see `qk`. |
| public API | Knows which clip is selected. **Cannot apply effects.** |
| QE DOM | Applies effects. **Has no concept of selection.** Undocumented; confirmed working on 26.3.2. |

The product is the seam between the last two. Neither can do the job alone and
Premiere ships no bridge between them.

## Layout

```
extension/   the CEP panel — UI, command catalogue, host-side ExtendScript
daemon/      Swift global-hotkey agent (macOS)
tools/       cdp.py, talks to the panel's devtools for debugging
docs/        product brief and the original mockup
```

Runtime config lives in `~/Library/Application Support/QuickKey/`, not here.

## Working on it

```bash
./dev-install     # copy extension/ into Premiere, rebuild the daemon
./start           # run the daemon
./stop            # kill it, releasing every bound key
./package         # build dist/QuickKey-mac.zip for sharing
./restore         # list or roll back config snapshots
```

`./qk '<extendscript>'` runs code inside the running Premiere and prints the
result — the fastest way to answer "does this API even exist?".

Requires the QuickKey panel open in Premiere (`Window > Extensions`).

## Known limits

- **Modifier combos only.** A bare hotkey is consumed system-wide with no way to
  hand it back — we proved this the hard way. Real single keys need an event tap
  and an Accessibility grant.
- **Capture stores numbers and toggles**, not colours or curves, so Lumetri
  grades do not round-trip yet. `getColorValue`/`setColorValue` exist and are
  the likely route.
- **Enum labels are a lookup table.** Premiere reports dropdowns as bare
  integers. We detect that a parameter *is* a dropdown by probing its bounds,
  but the option names have to be recorded by hand.
- **Unsigned.** Installing needs Premiere's `PlayerDebugMode` and a Terminal
  install on macOS 15+.
