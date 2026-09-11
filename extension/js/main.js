(function () {
  // Paths are derived, never hardcoded, so the panel runs on any machine and on
  // either platform. userData resolves to ~/Library/Application Support on macOS
  // and %APPDATA% on Windows; the extension path is wherever CEP installed us.
  // getSystemPath returns a file:// URL, not a filesystem path — cep.fs needs the
  // latter. Windows yields file:///C:/... so the leading slash is dropped there.
  function sysPath(kind) {
    var p = window.__adobe_cep__.getSystemPath(kind);
    if (p.indexOf("file://") === 0) p = p.slice(7);
    p = decodeURIComponent(p);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  }

  var ROOT   = sysPath("userData") + "/QuickKey";
  var BRIDGE = ROOT + "/bridge";
  var REQ = BRIDGE + "/request.json", RES = BRIDGE + "/response.json", BEAT = BRIDGE + "/heartbeat.json";
  var CONFIG = ROOT + "/quickkey.json";
  var HOSTJSX = sysPath("extension") + "/jsx/host.jsx";
  var GATE = "com.adobe.PremierePro.26";

  var elList = document.getElementById("list");
  var elLog  = document.getElementById("log");
  var listening = null;          // id awaiting a keypress
  var effectCache = {};      // per slot type
  var pickerTarget = null;
  var armError = null;
  var helpOpen = false;
  var armReady = false;
  var armTimer = null;
  var expanded = null;      // slot id whose captured settings are shown

  // state.keys maps a command id -> {key,mods}. Keys are shared across modes on
  // purpose: the point of a mode is that the SAME key does a different thing.
  var state = { activeMode: null, modes: [], keys: {} };

  function log(msg, cls) {
    var d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = msg;
    elLog.appendChild(d);
    while (elLog.childNodes.length > 60) elLog.removeChild(elLog.firstChild);
    elLog.scrollTop = elLog.scrollHeight;
  }
  (function ensureDirs(){
    try { window.cep.fs.makedir(ROOT); } catch (e) {}
    try { window.cep.fs.makedir(BRIDGE); } catch (e) {}
    try { window.cep.fs.makedir(BRIDGE + "/history"); } catch (e) {}
  })();

  function readFile(p){ try{ return window.cep.fs.readFile(p); }catch(e){ return {err:-1}; } }
  function writeFile(p,s){ try{ return window.cep.fs.writeFile(p,s); }catch(e){ return {err:-1}; } }

  // Premiere holds keyboard focus, and a single .focus() call frequently does
  // not take. Retry across a few frames and stop as soon as it lands — this is
  // what made the search box and the name fields feel intermittently broken.
  function focusSoon(node, tries) {
    if (!node) return;
    var attempts = tries || [0, 40, 120, 300, 600];
    for (var i = 0; i < attempts.length; i++) {
      (function (ms) {
        setTimeout(function () {
          if (document.activeElement === node) return;
          try { window.focus(); node.focus(); } catch (e) {}
        }, ms);
      })(attempts[i]);
    }
  }

  function evalHost(code, cb) {
    var wrapped = "(function(){try{return String(eval(" + JSON.stringify(code) +
                  "))}catch(e){return 'QK_ERR: '+e.toString()}})()";
    window.__adobe_cep__.evalScript(wrapped, cb || function(){});
  }

  function mode() {
    for (var i = 0; i < state.modes.length; i++)
      if (state.modes[i].id === state.activeMode) return state.modes[i];
    if (state.modes.length) {           // unknown id: recover, but say so
      log("unknown mode id, falling back to " + state.modes[0].name, "bad");
      state.activeMode = state.modes[0].id;
      return state.modes[0];
    }
    return null;
  }
  function uid(){ return "m" + Date.now().toString(36); }

  // Slots belong to a mode, not to the app. QK_SLOTS is only the template a new
  // mode starts from — every slot in it can be removed like any other.
  function allSlots() { var m = mode(); return (m && m.slots) || []; }
  function slotById(id) {
    var a = allSlots();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }
  // Slots stored in a mode carry only what varies (effect, params). Static
  // metadata such as the effect-family filter lives in the template.
  function templateFor(id) {
    for (var i = 0; i < QK_SLOTS.length; i++) if (QK_SLOTS[i].id === id) return QK_SLOTS[i];
    return null;
  }
  function scriptFor(slot, cfg) {
    if (slot.type === "audio")      return "qkApplyAudioEffect(" + JSON.stringify(cfg.effect) + ")";
    if (slot.type === "transition") return "qkApplyTransition("  + JSON.stringify(cfg.effect) + ")";
    return "qkApplyPreset(" + JSON.stringify(cfg.effect) + "," + JSON.stringify(cfg.params || "") + ")";
  }

  // ---------- undo history ----------
  //
  // Snapshots are taken BEFORE each destructive edit, so undo restores the state
  // you had a moment ago. Mode switching is deliberately excluded — it happens on
  // a hotkey many times a session and would bury the edits worth undoing.
  var history = [], future = [], HISTORY_MAX = 50;

  function snap() { return JSON.stringify({ activeMode: state.activeMode, modes: state.modes, keys: state.keys }); }
  function apply(json) {
    var j = JSON.parse(json);
    state.activeMode = j.activeMode; state.modes = j.modes; state.keys = j.keys;
  }
  function mark(desc) {
    history.push({ desc: desc, data: snap() });
    if (history.length > HISTORY_MAX) history.shift();
    future = [];
  }
  function undo() {
    if (!history.length) {
      // Nothing of ours to undo — pass it through, so cmd+z from the panel still
      // undoes the effect QuickKey just applied instead of doing nothing.
      evalHost("app.enableQE(); qe.project.undo(); 'undid in Premiere'", function (r) { log(String(r), "ok"); });
      return;
    }
    var h = history.pop();
    future.push({ desc: h.desc, data: snap() });
    apply(h.data); save(); renderAll();
    log("undid: " + h.desc, "ok");
  }
  function redo() {
    if (!future.length) { log("nothing to redo"); return; }
    var f = future.pop();
    history.push({ desc: f.desc, data: snap() });
    apply(f.data); save(); renderAll();
    log("redid: " + f.desc, "ok");
  }

  // Undo only reaches back as far as this panel session. Config is also written
  // to .bridge/history on every change, so a mistake survives a reload or a crash.
  function backup(json) {
    try {
      var dir = BRIDGE + "/history";
      window.cep.fs.writeFile(dir + "/config-" + Date.now() + ".json", json);
      var d = window.cep.fs.readdir(dir);
      if (d && d.err === 0 && d.data && d.data.length > 40) {
        d.data.sort();
        for (var i = 0; i < d.data.length - 40; i++) {
          try { window.cep.fs.deleteFile(dir + "/" + d.data[i]); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // ---------- confirmation ----------
  function confirmThen(msg, yesLabel, onYes) {
    var bar = document.getElementById("confirmBar");
    bar.className = "confirmbar show";
    bar.innerHTML = "";
    var t = document.createElement("span"); t.textContent = msg; bar.appendChild(t);
    var yes = document.createElement("button"); yes.className = "danger"; yes.textContent = yesLabel;
    var no  = document.createElement("button"); no.textContent = "Cancel";
    yes.onclick = function () { bar.className = "confirmbar"; onYes(); };
    no.onclick  = function () { bar.className = "confirmbar"; log("cancelled"); };
    bar.appendChild(yes); bar.appendChild(no);
  }

  // ---------- config ----------
  function newMode(name) {
    // Fresh copies, so editing one mode's defaults never touches another's.
    var slots = QK_SLOTS.map(function (t) {
      return { id: t.id, label: t.label, type: t.type, icon: t.icon,
               effect: t.fallback || "", params: "" };
    });
    return { id: uid(), name: name, key: "", mods: QK_DEFAULT_MODS.slice(), slots: slots };
  }

  function loadConfig() {
    var r = readFile(CONFIG);
    if (r.err === 0 && r.data) {
      try {
        var j = JSON.parse(r.data);
        if (j.modes && j.modes.length) {
          // Older configs stored slots as an object keyed by id, with slot
          // metadata held globally. Fold that into a per-mode array.
          var meta = QK_SLOTS.concat(j.customSlots || []);
          j.modes.forEach(function (m) {
            if (Object.prototype.toString.call(m.slots) === "[object Array]") return;
            var arr = [];
            meta.forEach(function (t) {
              var cfg = m.slots[t.id];
              if (!cfg) return;
              arr.push({ id: t.id, label: t.label, type: t.type, icon: t.icon,
                         effect: cfg.effect || "", params: cfg.params || "" });
            });
            m.slots = arr;
          });
          state.modes = j.modes;
          state.helpSeen = !!j.helpSeen;
          state.seeded = j.seeded || [];
          state.activeMode = j.activeMode || j.modes[0].id;
          state.keys = j.keys || {};
          return;
        }
      } catch (e) { log("config unreadable — starting fresh", "bad"); }
    }
    // first run
    var m = newMode("Editing"); m.key = "1";
    state.modes = [m];
    state.activeMode = m.id;
    QK_SLOTS.forEach(function (s){ if (s.defaultKey) state.keys[s.id] = {key:s.defaultKey, mods:QK_DEFAULT_MODS.slice()}; });
    QK_ACTIONS.forEach(function (a){ if (a.defaultKey) state.keys[a.id] = {key:a.defaultKey, mods:QK_DEFAULT_MODS.slice()}; });
  }

  // The daemon only ever reads `bindings`. Everything else in the file is the
  // panel's own state, rebuilt into bindings on every change.
  // Drop any slot id that is not in the catalogue (an earlier bug could write one).
  // Rewrite any stored params that still carry internal properties, so they are
  // removed from the file rather than just hidden in the UI.
  // A command added in a newer build has no key in an existing config. Give it
  // its default once, recording that we did — otherwise a key the user cleared
  // on purpose would come back on every launch.
  function seedNewActions() {
    state.seeded = state.seeded || [];
    var added = [];
    QK_ACTIONS.forEach(function (a) {
      if (!a.defaultKey) return;
      var known = false;
      for (var i = 0; i < state.seeded.length; i++) if (state.seeded[i] === a.id) known = true;
      if (known || state.keys[a.id]) { if (!known) state.seeded.push(a.id); return; }
      state.keys[a.id] = { key: a.defaultKey, mods: QK_DEFAULT_MODS.slice() };
      state.seeded.push(a.id);
      added.push(a.label);
    });
    if (added.length) log("new command: " + added.join(", "), "ok");
  }

  function scrubParams() {
    var n = 0;
    state.modes.forEach(function (m) {
      for (var k in m.slots) {
        var cur = m.slots[k].params;
        if (!cur) continue;
        var kept = cur.split("|").filter(function (pair) {
          var eq = pair.lastIndexOf("=");
          if (eq < 1) return false;
          var name = pair.slice(0, eq);
          return !QK_HIDDEN_PARAMS[name] && name.charAt(0) !== "_";
        }).join("|");
        if (kept !== cur) { m.slots[k].params = kept; n++; }
      }
    });
    if (n) log("cleaned internal properties from " + n + " saved default(s)", "ok");
  }

  // A slot the user removed must stay removed, so nothing is re-seeded here.
  // Only brand-new modes get the core template.

  function scrubParams() {
    var n = 0;
    state.modes.forEach(function (m) {
      (m.slots || []).forEach(function (sl) {
        if (!sl.params) return;
        var kept = sl.params.split("|").filter(function (pair) {
          var eq = pair.lastIndexOf("=");
          if (eq < 1) return false;
          var name = pair.slice(0, eq);
          return !QK_HIDDEN_PARAMS[name] && name.charAt(0) !== "_";
        }).join("|");
        if (kept !== sl.params) { sl.params = kept; n++; }
      });
    });
    if (n) log("cleaned internal properties from " + n + " default(s)", "ok");
  }

  function buildBindings() {
    var out = [], m = mode();
    ((m && m.slots) || []).forEach(function (s) {
      var k = state.keys[s.id];
      if (!k || !k.key || !s.effect) return;
      out.push({ id:s.id, key:k.key, mods:k.mods, label:s.label + " (" + s.effect + ")",
                 script:scriptFor(s, s) });
    });
    QK_ACTIONS.forEach(function (a) {
      var k = state.keys[a.id];
      if (!k || !k.key) return;
      out.push({ id:a.id, key:k.key, mods:k.mods, label:a.label, script:a.script });
    });
    state.modes.forEach(function (md) {
      if (!md.key) return;
      out.push({ id:"mode:"+md.id, key:md.key, mods:md.mods||QK_DEFAULT_MODS,
                 label:"Mode: "+md.name, script:"QK_MODE:"+md.id });
    });
    return out;
  }

  function save() {
    var out = { onlyWhenFrontmost:GATE, activeMode:state.activeMode, helpSeen:!!state.helpSeen,
                seeded:state.seeded || [],
                modes:state.modes, keys:state.keys, bindings:buildBindings() };
    var json = JSON.stringify(out, null, 2);
    if (writeFile(CONFIG, json).err !== 0) log("could not write config", "bad");
    backup(json);
  }

  // Premiere keeps keyboard focus for its own shortcuts, so a CEP panel gets no
  // keydown at all unless it registers interest in specific combinations. Without
  // this, capturing a shortcut silently never fires.
  (function registerKeys() {
    if (typeof window.__adobe_cep__.registerKeyEventsInterest !== "function") return;
    var codes = [8, 27];                                   // backspace, escape
    for (var c = 48; c <= 57; c++) codes.push(c);          // 0-9
    for (var c = 65; c <= 90; c++) codes.push(c);          // A-Z
    for (var c = 112; c <= 123; c++) codes.push(c);        // F1-F12
    var mods = [
      {}, {ctrlKey:1}, {altKey:1}, {metaKey:1},
      {ctrlKey:1,altKey:1}, {ctrlKey:1,shiftKey:1}, {altKey:1,shiftKey:1},
      {ctrlKey:1,altKey:1,shiftKey:1}, {metaKey:1,altKey:1}, {metaKey:1,shiftKey:1}
    ];
    var want = [];
    for (var i = 0; i < codes.length; i++) {
      for (var m = 0; m < mods.length; m++) {
        var e = { keyCode: codes[i] };
        for (var k in mods[m]) e[k] = true;
        want.push(e);
      }
    }
    try {
      var res = window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(want));
      log("keyboard registered (" + want.length + " combos)", "ok");
    } catch (e) { log("could not register keyboard: " + e, "bad"); }
  })();

  // ---------- help ----------
  // Kept out of the way rather than occupying the panel permanently: this is a
  // tool for reclaiming screen space, so standing instructions are a poor trade.
  function helpRow(symbolHTML, symbolText, text) {
    var r = document.createElement("div"); r.className = "helprow";
    var k = document.createElement("div"); k.className = "helpkey";
    if (symbolHTML) k.innerHTML = symbolHTML; else k.textContent = symbolText;
    var t = document.createElement("div"); t.className = "helptext"; t.textContent = text;
    r.appendChild(k); r.appendChild(t);
    return r;
  }

  // Shown once, when the help card is first dismissed — the only moment the "?"
  // is genuinely ambiguous. A standing badge would tax attention forever to say
  // something the user needs once, which is the anti-pattern worth avoiding.
  function renderHelp() {
    var el = document.getElementById("help");
    el.innerHTML = "";
    el.className = helpOpen ? "help open" : "help";
    if (!helpOpen) return;

    el.appendChild(helpRow(null, "Ctrl+Opt+B", "Click a key box, then hold Control and Option and press a key."));
    el.appendChild(helpRow(QK_ICON.blur, null, "Click a row to choose which effect it applies."));
    el.appendChild(helpRow(QK_ICON.play, null, "Apply it to the clip you have selected, without the shortcut."));
    el.appendChild(helpRow(QK_ICON.pick, null, "Set an effect up on a clip, keep it selected, then press this to make those settings your default."));
    el.appendChild(helpRow(null, "\u00d7", "Remove that default from this mode."));
    el.appendChild(helpRow(QK_ICON.mode, null, "A mode is a set of defaults. The same key can apply a different effect in each one."));

    var close = document.createElement("div");
    close.className = "helpclose";
    close.textContent = "Got it";
    close.onclick = function () {
      helpOpen = false; state.helpSeen = true; save(); renderHelp();
    };
    el.appendChild(close);
  }

  document.getElementById("helpBtn").onclick = function () {
    helpOpen = !helpOpen;
    if (!helpOpen) { state.helpSeen = true; save(); renderHelp(); return; }
    renderHelp();
  };

  // ---------- rendering ----------
  // "Name=value", "Name=value~min~max" or "Name=true~bool"
  function parseParams(str) {
    if (!str) return [];
    return str.split("|").map(function (pair) {
      var eq = pair.lastIndexOf("=");
      if (eq < 1) return null;
      var bits = pair.slice(eq + 1).split("~");
      var v = bits[0], min = null, max = null;
      if (bits[1] === "bool") { /* boolean */ }
      else if (bits.length === 3) {
        var a = parseFloat(bits[1]), b = parseFloat(bits[2]);
        if (a === a && b === b) { min = a; max = b; }
      }
      if (v !== "true" && v !== "false") {
        var f = parseFloat(v);
        if (f === f) v = (Math.round(f * 1000) / 1000).toString();
      }
      return { name: pair.slice(0, eq), value: v, min: min, max: max };
    }).filter(function (x) {
      return x && !QK_HIDDEN_PARAMS[x.name] && x.name.charAt(0) !== "_";
    });
  }

  // A small integer span is how an enum looks once you have probed its bounds.
  function isEnum(kv) {
    return kv.min !== null && kv.max !== null &&
           kv.min === Math.round(kv.min) && kv.max === Math.round(kv.max) &&
           (kv.max - kv.min) > 0 && (kv.max - kv.min) <= 12;
  }

  // Real bounds win, except when they are so wide the slider becomes useless
  // (Angle probes to -32768..32767). Then narrow the slider and let the number
  // field reach the rest.
  function sliderRange(kv) {
    var v = parseFloat(kv.value) || 0;
    if (kv.min !== null && (kv.max - kv.min) <= 3600) {
      var span = kv.max - kv.min;
      return { min: kv.min, max: kv.max, step: span <= 5 ? 0.01 : (span <= 100 ? 0.1 : 1) };
    }
    var r = rangeFor(kv.name, v);
    if (kv.min !== null) { r.min = Math.max(r.min, kv.min); r.max = Math.min(r.max, kv.max); }
    return r;
  }

  // Premiere exposes getValue/setValue but never a parameter's range, so ranges
  // are inferred from the name and the captured value. The number field is the
  // real control — the slider is a convenience that never clamps what you type.
  // Number inputs have no intrinsic content sizing, so width is set by hand:
  // snug around the digits, with room to grow for large or negative values.
  function fitNum(el) {
    var n = String(el.value === "" ? 0 : el.value).length;
    el.style.width = Math.min(74, Math.max(30, n * 6.7 + 12)) + "px";
  }

  function rangeFor(name, v) {
    var n = name.toLowerCase();
    if (/angle|rotation|direction|hue/.test(n))        return { min: 0,    max: 360, step: 1 };
    if (/opacity|mix|blend|amount %|percent/.test(n))  return { min: 0,    max: 100, step: 1 };
    if (/saturation|contrast|exposure|gamma/.test(n))  return { min: -100, max: 100, step: 0.1 };
    // A captured 0 carries no scale information — don't infer a 0..1 range from it.
    if (v === 0)                                       return { min: 0,    max: 100, step: 1 };
    if (Math.abs(v) <= 1)                              return { min: 0,    max: 1,   step: 0.01 };
    var top = Math.max(100, Math.pow(10, Math.ceil(Math.log(Math.abs(v) * 2 || 1) / Math.LN10)));
    return { min: 0, max: top, step: (top <= 10 ? 0.1 : 1) };
  }

  function setParam(slotId, name, value) {
    var sl = slotById(slotId); if (!sl) return;
    var parts = parseParams(sl.params).map(function (kv) {
      var v = (kv.name === name ? value : kv.value);
      var tail = (kv.value === "true" || kv.value === "false") ? "~bool"
               : (kv.min !== null ? "~" + kv.min + "~" + kv.max : "");
      return kv.name + "=" + v + tail;
    });
    sl.params = parts.join("|");
  }

  function combo(k){
    if (!k || !k.key) return null;
    // Mac modifier glyphs are hard to tell apart at this size; spell them out.
    return (k.mods||[]).map(function(x){ return {ctrl:"Ctrl",opt:"Opt",cmd:"Cmd",shift:"Shift"}[x]||x; })
             .concat([k.key]).join("+");
  }

  // The daemon holds these combos globally, so it would swallow the very
  // keystroke we are trying to capture — and run that command instead. Ask it to
  // let go first, and only prompt once it confirms.
  function beginArming(id) {
    listening = id; armError = null; armReady = false; renderAll();
    // Give the view something focusable, or real keystrokes never arrive.
    var el = document.getElementById("cmd-" + id);
    if (el) { el.tabIndex = -1; focusSoon(el); }
    writeFile(BRIDGE + "/suspend.json", JSON.stringify({ on: true, t: Date.now() }));

    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      var ok = false;
      var r = readFile(BRIDGE + "/suspended.json");
      if (r.err === 0 && r.data) { try { ok = JSON.parse(r.data).suspended === true; } catch (e) {} }
      if (ok || tries > 25) {
        clearInterval(poll);
        armReady = true;
        if (!ok) log("could not pause shortcuts — is QuickKeyDaemon running?", "bad");
        renderAll();
      }
    }, 100);

    clearTimeout(armTimer);
    armTimer = setTimeout(function () { if (listening === id) endArming(); }, 25000);
  }

  function endArming() {
    listening = null; armReady = false; armError = null;
    clearTimeout(armTimer);
    writeFile(BRIDGE + "/suspend.json", JSON.stringify({ on: false, t: Date.now() }));
    renderAll();
  }

  function chipFor(id, keyObj, onAssign) {
    var c = document.createElement("div");
    var t = combo(keyObj);
    c.className = "chip" + (t ? "" : " empty") + (listening === id ? " arming" : "");
    // An empty slot said "—", which reads as "none" rather than "click me".
    c.textContent = (listening === id) ? (armReady ? "press…" : "wait…") : (t || "set key");
    c.title = "Click, then hold Ctrl and Option and press a key. Backspace clears it.";
    c.onclick = function(e){
      e.stopPropagation();
      if (listening === id) endArming(); else beginArming(id);
    };
    return c;
  }

  function groupHead(title, note, addable) {
    var g = document.createElement("div"); g.className = "group";
    var a = document.createElement("span"); a.textContent = title; g.appendChild(a);
    if (note) { var b = document.createElement("em"); b.textContent = note; g.appendChild(b); }
    if (addable) {
      var plus = document.createElement("em");
      plus.className = "addslot"; plus.textContent = "+ add QuickKey";
      plus.onclick = openSlotAdd;
      g.appendChild(plus);
    }
    elList.appendChild(g);
  }

  function renderAll() {
    // mode dropdown
    var sel = document.getElementById("modeSelect");
    sel.innerHTML = "";
    state.modes.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id; o.textContent = m.name;
      if (m.id === state.activeMode) o.selected = true;
      sel.appendChild(o);
    });

    elList.innerHTML = "";
    var m = mode();

    groupHead("Defaults", m ? m.name : "", true);
    allSlots().forEach(function (s) {
      var cfg = s;
      var row = document.createElement("div");
      row.className = "cmd" + (listening === s.id ? " listening" : "");
      row.id = "cmd-" + s.id;

      row.appendChild(chipFor(s.id, state.keys[s.id]));

      var ic = document.createElement("div"); ic.className = "icon";
      ic.innerHTML = qkIconFor(cfg.effect, s.icon); row.appendChild(ic);

      var body = document.createElement("div"); body.className = "body";
      var lb = document.createElement("div"); lb.className = "label"; lb.textContent = s.label;
      var sub = document.createElement("div");
      sub.className = "sub" + (cfg.effect ? "" : " unset");
      sub.textContent = (listening === s.id)
        ? (armError || (armReady ? "press a key, or pick one below"
                                 : "pausing shortcuts\u2026"))
        : (cfg.effect || "choose an effect\u2026");
      if (listening === s.id) sub.className = "sub arming" + (armError ? " err" : "");
      if (listening === s.id && armReady) body.appendChild(keyChooser(s.id));
      sub.onclick = function(e){ e.stopPropagation(); openPicker(s.id, cfg.effect); };
      body.appendChild(lb); body.appendChild(sub);

      if (cfg.effect && s.type === "video") {
        var n = parseParams(cfg.params).length;
        var badge = document.createElement("div");
        badge.className = "settings";
        // Always expandable: an empty slot is exactly where someone needs to be
        // told that capturing their own settings is possible.
        badge.textContent = (expanded === s.id ? "\u2304 " : "\u203a ") +
          (n ? "your settings (" + n + ")" : "using Premiere\u2019s settings");
        badge.onclick = function (e) {
          e.stopPropagation(); expanded = (expanded === s.id) ? null : s.id; renderAll();
        };
        body.appendChild(badge);
      }
      row.appendChild(body);

      var run = document.createElement("div");
      run.className = "iconbtn";
      run.innerHTML = QK_ICON.play;
      run.title = "Apply this to the selected clip right now";
      run.onclick = function (e) {
        e.stopPropagation();
        runCommand(s.id, s.effect ? scriptFor(s, s) : "",
                   s.label + (s.effect ? " (" + s.effect + ")" : ""));
      };
      row.appendChild(run);

      // Capture earns a place on the row: buried in the settings drawer, nobody
      // found it. The drawer keeps the step-by-step for first-timers.
      if (cfg.effect && s.type === "video") {
        var grab = document.createElement("div");
        grab.className = "iconbtn";
        grab.innerHTML = QK_ICON.pick;
        grab.title = "Save the selected clip\u2019s settings as this default";
        grab.onclick = function (e) { e.stopPropagation(); capture(s.id, cfg.effect); };
        row.appendChild(grab);
      }

      if (s.type !== "video") {
        var pill = document.createElement("div");
        pill.className = "tpill";
        pill.textContent = (s.type === "audio" ? "audio" : "trans");
        row.appendChild(pill);
      }
      // Any default can be removed, core ones included — they are only a starting
      // point. Removal is scoped to this mode; other modes keep theirs.
      var rm = document.createElement("div");
      rm.className = "rmslot"; rm.textContent = "\u00d7";
      rm.title = "Remove this QuickKey from " + (m ? m.name : "this mode");
      rm.onclick = function (e) {
        e.stopPropagation();
        confirmThen("Remove \u201c" + s.label + "\u201d from \u201c" + (m ? m.name : "") + "\u201d?", "Remove", function () {
          mark("remove \u201c" + s.label + "\u201d from " + (m ? m.name : ""));
          var md = mode();
          md.slots = md.slots.filter(function (x) { return x.id !== s.id; });
          save(); renderAll();
          log("removed \u201c" + s.label + "\u201d — \u2318Z to undo", "ok");
        });
      };
      row.appendChild(rm);
      row.title = "Click to run this now";
      // Clicking a row opens its settings, never fires it. The obvious gesture
      // must be the safe one — a first-time user clicking a row expects to
      // configure it, not to have an effect land on their timeline.
      row.title = "Change which effect this applies";
      row.onclick = function () { openPicker(s.id, s.effect); };

      elList.appendChild(row);

      if (expanded === s.id) {
        var det = document.createElement("div"); det.className = "details";
        if (!cfg.params) {
          var none = document.createElement("div");
          none.className = "nosettings";
          none.textContent = "Right now this adds " + (cfg.effect || "the effect") +
            " with Premiere\u2019s default settings. To use your own:";
          det.appendChild(none);
        }
        parseParams(cfg.params).forEach(function (kv) {
          var line = document.createElement("div"); line.className = "kv";
          var a = document.createElement("span"); a.className = "pname"; a.textContent = kv.name;
          line.appendChild(a);

          if (kv.value === "true" || kv.value === "false") {
            var cb = document.createElement("input");
            cb.type = "checkbox"; cb.className = "pbool"; cb.checked = (kv.value === "true");
            cb.onchange = function () {
              mark("set " + kv.name);
              setParam(s.id, kv.name, cb.checked ? "true" : "false");
              save();
            };
            line.appendChild(cb); det.appendChild(line); return;
          }

          if (isEnum(kv)) {
            var sel = document.createElement("select");
            sel.className = "penum";
            var labels = QK_ENUM_LABELS[kv.name];
            for (var iv = kv.min; iv <= kv.max; iv++) {
              var o = document.createElement("option");
              o.value = iv;
              o.textContent = (labels && labels[iv - kv.min]) ? labels[iv - kv.min] : ("Option " + iv);
              if (iv === Math.round(parseFloat(kv.value))) o.selected = true;
              sel.appendChild(o);
            }
            sel.onchange = function () {
              mark("set " + kv.name);
              setParam(s.id, kv.name, sel.value, kv);
              save();
            };
            line.appendChild(sel); det.appendChild(line); return;
          }

          var v = parseFloat(kv.value), r = sliderRange(kv);
          var sl = document.createElement("input");
          sl.type = "range"; sl.className = "prange";
          sl.min = Math.min(r.min, v); sl.max = Math.max(r.max, v);
          sl.step = r.step; sl.value = v;

          var nb = document.createElement("input");
          nb.type = "number"; nb.className = "pnum"; nb.step = r.step; nb.value = v;
          fitNum(nb);

          // Snapshot on grab, commit on release: dragging stays smooth and one
          // drag is one undo step rather than hundreds.
          sl.onmousedown = function () { mark("adjust " + kv.name); };
          sl.oninput  = function () { nb.value = sl.value; fitNum(nb); setParam(s.id, kv.name, sl.value); };
          sl.onchange = function () { save(); };

          nb.onfocus  = function () { mark("edit " + kv.name); };
          nb.onchange = function () {
            var x = parseFloat(nb.value); if (x !== x) { nb.value = sl.value; return; }
            if (x > parseFloat(sl.max)) sl.max = x;
            if (x < parseFloat(sl.min)) sl.min = x;
            sl.value = x; fitNum(nb); setParam(s.id, kv.name, nb.value); save();
          };
          nb.onkeydown = function (e) { e.stopPropagation(); };
          nb.oninput   = function () { fitNum(nb); };

          line.appendChild(sl); line.appendChild(nb);
          det.appendChild(line);
        });
        // Concrete steps naming this effect and this key: the old copy assumed
        // the reader already knew what "capture" was for.
        var keyTxt = combo(state.keys[s.id]) || "This shortcut";
        var fxName = cfg.effect || "the effect";

        var steps = document.createElement("ol");
        steps.className = "capturesteps";
        [ "Add " + fxName + " to a clip and adjust it in Effect Controls.",
          "Leave that clip selected.",
          "Click Capture below."
        ].forEach(function (t) {
          var li = document.createElement("li"); li.textContent = t; steps.appendChild(li);
        });
        det.appendChild(steps);

        var outcome = document.createElement("div");
        outcome.className = "captureoutcome";
        outcome.textContent = keyTxt + " will then add " + fxName + " with those exact settings.";
        det.appendChild(outcome);

        var capBtn = document.createElement("div");
        capBtn.className = "capturebtn";
        capBtn.textContent = cfg.params ? "Re-capture" : "Capture from selected clip";
        capBtn.onclick = function (e) { e.stopPropagation(); capture(s.id, cfg.effect); };
        det.appendChild(capBtn);

        var clear = document.createElement("div");
        clear.className = "clearparams";
        clear.textContent = "Clear captured settings — use the effect's own defaults";
        clear.onclick = function () {
          mark("clear captured settings"); s.params = "";
          expanded = null; save(); renderAll(); log("cleared captured settings", "ok");
        };
        if (cfg.params) det.appendChild(clear);
        elList.appendChild(det);
      }
    });

    groupHead("Actions");
    QK_ACTIONS.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "cmd" + (listening === a.id ? " listening" : "");
      row.id = "cmd-" + a.id;
      row.appendChild(chipFor(a.id, state.keys[a.id]));
      var ic = document.createElement("div"); ic.className="icon"; ic.innerHTML = QK_ICON[a.icon]||"";
      row.appendChild(ic);
      var body = document.createElement("div"); body.className="body";
      var lb = document.createElement("div"); lb.className="label"; lb.textContent = a.label;
      body.appendChild(lb); row.appendChild(body);
      var arun = document.createElement("div");
      arun.className = "iconbtn";
      arun.innerHTML = QK_ICON.play;
      arun.title = "Run this on the selected clip right now";
      arun.onclick = function (e) { e.stopPropagation(); runCommand(a.id, a.script, a.label); };
      row.appendChild(arun);
      elList.appendChild(row);
    });

    groupHead("Modes", "same key, different effect");
    state.modes.forEach(function (md) {
      var row = document.createElement("div");
      var id = "mode:" + md.id;
      row.className = "cmd" + (listening === id ? " listening" : "") + (md.id===state.activeMode ? " active":"");
      row.id = "cmd-" + id;
      row.appendChild(chipFor(id, { key:md.key, mods:md.mods }));
      var ic = document.createElement("div"); ic.className="icon"; ic.innerHTML = QK_ICON.mode;
      row.appendChild(ic);
      var body = document.createElement("div"); body.className="body";
      var lb = document.createElement("div"); lb.className="label"; lb.textContent = md.name;
      body.appendChild(lb); row.appendChild(body);
      if (md.id === state.activeMode) {
        var d = document.createElement("div"); d.className="dotmark"; row.appendChild(d);
      }
      row.onclick = function(){ switchMode(md.id); };
      elList.appendChild(row);
    });
  }

  // Running from the panel as well as from a hotkey: the fastest way to check a
  // default does what you meant without leaving the panel to go press a key.
  function runCommand(id, script, label) {
    if (!script) { log("nothing set for " + label, "bad"); return; }
    evalHost(script, function (result) {
      var bad = String(result).indexOf("QK_ERR") === 0 ||
                String(result).indexOf("ERR:") === 0 || result === "EvalScript error.";
      flash(id, bad ? "bad" : "fired");
      log(String(result).slice(0, 160), bad ? "bad" : "ok");
      if (bad) toast(String(result).replace(/^(QK_)?ERR:\s*/, ""), false);
    });
  }

  // Toasts are drawn by the daemon (a panel cannot paint outside its own frame),
  // so the panel asks for one by leaving a note in the bridge.
  function toast(text, ok) {
    writeFile(BRIDGE + "/toast.json", JSON.stringify({ id: String(Date.now()), text: text, ok: !!ok }));
  }

  // Key capture depends on Premiere releasing focus, which it does not always do.
  // This picker always works, because it needs only the mouse.
  function keyChooser(id) {
    var wrap = document.createElement("div"); wrap.className = "chooser";
    var chosen = { ctrl: true, opt: true, shift: false, cmd: false };

    ["ctrl", "opt", "shift", "cmd"].forEach(function (m) {
      var b = document.createElement("span");
      b.className = "modchip" + (chosen[m] ? " on" : "");
      b.textContent = { ctrl: "Ctrl", opt: "Opt", shift: "Shift", cmd: "Cmd" }[m];
      b.onclick = function (e) {
        e.stopPropagation();
        chosen[m] = !chosen[m];
        b.className = "modchip" + (chosen[m] ? " on" : "");
      };
      wrap.appendChild(b);
    });

    var sel = document.createElement("select"); sel.className = "keysel";
    var keys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
    for (var f = 1; f <= 8; f++) keys.push("F" + f);
    keys.forEach(function (k) {
      var o = document.createElement("option"); o.value = k; o.textContent = k; sel.appendChild(o);
    });
    sel.onclick = function (e) { e.stopPropagation(); };
    wrap.appendChild(sel);

    var set = document.createElement("span");
    set.className = "setbtn"; set.textContent = "Set";
    set.onclick = function (e) {
      e.stopPropagation();
      var mods = [];
      ["ctrl", "opt", "cmd", "shift"].forEach(function (m) { if (chosen[m]) mods.push(m); });
      if (!mods.length) { armError = "pick Ctrl or Opt as well"; renderAll(); return; }
      assignKey(id, sel.value, mods);
    };
    wrap.appendChild(set);
    return wrap;
  }

  function assignKey(target, key, mods) {
    armError = null;
    mark("rebind key");
    for (var other in state.keys) {
      if (state.keys[other].key === key &&
          (state.keys[other].mods || []).join() === mods.join() && other !== target) {
        delete state.keys[other];
      }
    }
    if (target.indexOf("mode:") === 0) {
      state.modes.forEach(function (m) { if ("mode:" + m.id === target) { m.key = key; m.mods = mods; } });
    } else {
      state.keys[target] = { key: key, mods: mods };
    }
    log("bound " + combo({ key: key, mods: mods }), "ok");
    save(); endArming();
  }

  function flash(id, cls) {
    var el = document.getElementById("cmd-" + id);
    if (!el) return;
    var base = el.className.replace(/ (fired|bad)/g, "");
    el.className = base + " " + cls;
    setTimeout(function(){ el.className = base; }, 700);
  }

  // ---------- modes ----------
  function switchMode(id) {
    if (state.activeMode === id) return;
    state.activeMode = id;
    save();                      // rewrites bindings; daemon reloads within ~1s
    renderAll();
    log("mode → " + mode().name, "ok");
  }

  document.getElementById("modeSelect").onchange = function(){ switchMode(this.value); };
  document.getElementById("modeAdd").onclick = function () {
    var w = document.getElementById("modeNameWrap");
    w.className = "newmode show";
    var i = document.getElementById("modeName"); i.value = ""; focusSoon(i);
  };
  document.getElementById("modeName").onkeydown = function (e) {
    e.stopPropagation();
    if (e.key === "Escape") { document.getElementById("modeNameWrap").className = "newmode"; return; }
    if (e.key !== "Enter") return;
    var name = this.value.trim(); if (!name) return;
    mark("create mode \u201c" + name + "\u201d");
    // A new mode starts from the core defaults, not from the current mode.
    var m = newMode(name);
    state.modes.push(m); state.activeMode = m.id;
    document.getElementById("modeNameWrap").className = "newmode";
    save(); renderAll(); log("created mode '" + name + "'", "ok");
  };
  document.getElementById("modeDel").onclick = function () {
    if (state.modes.length < 2) { log("keep at least one mode", "bad"); return; }
    var m = mode(); if (!m) return;
    confirmThen("Delete mode \u201c" + m.name + "\u201d? Its effect defaults go with it.", "Delete", function () {
      mark("delete mode \u201c" + m.name + "\u201d");
      state.modes = state.modes.filter(function (x) { return x.id !== m.id; });
      state.activeMode = state.modes[0].id;
      save(); renderAll();
      log("deleted \u201c" + m.name + "\u201d — \u2318Z to undo", "ok");
    });
  };

  // ---------- custom defaults ----------
  function openSlotAdd() {
    var w = document.getElementById("slotAddWrap");
    var sel = document.getElementById("slotType");
    if (!sel.options.length) {
      QK_SLOT_TYPES.forEach(function (t) {
        var o = document.createElement("option"); o.value = t.id; o.textContent = t.label;
        sel.appendChild(o);
      });
    }
    w.className = "newmode show";
    var i = document.getElementById("slotName"); i.value = ""; focusSoon(i);
  }

  document.getElementById("slotName").onkeydown = function (e) {
    e.stopPropagation();
    if (e.key === "Escape") { document.getElementById("slotAddWrap").className = "newmode"; return; }
    if (e.key !== "Enter") return;
    var name = this.value.trim(); if (!name) return;
    var type = document.getElementById("slotType").value;

    mark("add \u201c" + name + "\u201d");
    var slot = { id: "s" + Date.now().toString(36), label: name, type: type,
                 icon: type === "audio" ? "audio" : (type === "transition" ? "trans" : "wand"),
                 effect: "", params: "" };
    mode().slots.push(slot);
    document.getElementById("slotAddWrap").className = "newmode";
    save(); renderAll();
    log("added \u201c" + name + "\u201d — pick its effect, then give it a key", "ok");
  };

  // ---------- effect picker ----------
  function openPicker(slotId, current) {
    pickerTarget = slotId;
    var slot = slotById(slotId);
    var type = slot ? slot.type : "video";
    document.getElementById("pickerTitle").textContent = "Effect for " + (slot ? slot.label : slotId);
    var pk = document.getElementById("picker");
    pk.className = "picker show";
    pk.tabIndex = -1; focusSoon(pk, [0, 40, 120]);
    // Focused so typing works immediately. Backspace on an empty box still goes
    // back, so the two behaviours no longer conflict.
    var box = document.getElementById("pickerSearch"); box.value = "";
    focusSoon(box);

    // An empty array is truthy: caching one failed load left the picker showing
    // "no match" forever, with no way to recover short of reopening the panel.
    if (effectCache[type] && effectCache[type].length) return drawPicker("", current);

    document.getElementById("pickerList").innerHTML = "<div class='fx'>loading\u2026</div>";
    var cmd = type === "audio" ? "qkListAudioEffects()"
            : type === "transition" ? "qkListTransitions()" : "qkListEffects()";

    // The panel can reopen faster than Premiere re-evaluates host.jsx, and
    // asking for the list before then quietly returned nothing.
    ensureHost(function (ready) {
      if (!ready) return pickerError("Premiere has not answered yet.", slotId, current);
      evalHost(cmd, function (r) {
        // Premiere lists some effects twice under one name (Transform, Noise
        // (Legacy)). We resolve effects by name, so both rows would apply the
        // identical effect — showing two is confusion with no upside.
        var seen = {};
        var list = String(r).split("|").filter(function (x) {
          if (!x || x.indexOf("QK_ERR") === 0 || seen[x]) return false;
          seen[x] = 1; return true;
        });
        if (!list.length) return pickerError("Could not read the effect list.", slotId, current);
        effectCache[type] = list;
        box.placeholder = "Search\u2026";
        drawPicker("", current);
      });
    });
  }

  // Never show "no match" when the truth is "nothing loaded" — that sent Dom
  // looking for a search bug that was really a loading failure.
  function pickerError(msg, slotId, current) {
    var list = document.getElementById("pickerList");
    list.innerHTML = "";
    var e = document.createElement("div");
    e.className = "fx";
    e.textContent = msg + "  Tap to try again.";
    e.onclick = function () { openPicker(slotId, current); };
    list.appendChild(e);
    log(msg, "bad");
  }

  // Confirms the host functions exist, reloading them if Premiere has forgotten.
  function ensureHost(cb) {
    evalHost("typeof qkListEffects", function (t) {
      if (String(t) === "function") return cb(true);
      evalHost("$.evalFile(File(" + JSON.stringify(HOSTJSX) + ")); typeof qkListEffects",
        function (t2) { cb(String(t2) === "function"); });
    });
  }


  var TYPE_LABEL = { video: "video effect", audio: "audio effect", transition: "transition" };
  var TYPE_CMD   = { video: "qkListEffects()", audio: "qkListAudioEffects()", transition: "qkListTransitions()" };

  function loadType(type, cb) {
    if (effectCache[type] && effectCache[type].length) return cb(effectCache[type]);
    evalHost(TYPE_CMD[type], function (r) {
      var seen = {};
      var list = String(r).split("|").filter(function (x) {
        if (!x || x.indexOf("QK_ERR") === 0 || seen[x]) return false;
        seen[x] = 1; return true;
      });
      if (list.length) effectCache[type] = list;
      cb(list);
    });
  }

  // "No match" was a lie: the effect existed, in a catalogue this slot does not
  // search. Look next door before telling someone their effect is not real.
  // "No match" was a lie: the effect existed, in a catalogue this slot does not
  // search. Look next door before telling someone their effect is not real.
  function lookElsewhere(ql, currentType, slotId, node) {
    var others = ["video", "audio", "transition"].filter(function (t) { return t !== currentType; });
    var found = [], pending = others.length;

    others.forEach(function (t) {
      loadType(t, function (list) {
        list.forEach(function (n) {
          if (n.toLowerCase().indexOf(ql) !== -1) found.push({ type: t, name: n });
        });
        if (--pending === 0) showElsewhere(found, currentType, slotId, node);
      });
    });
  }

  // Three reasons a search comes up empty, and they need different answers:
  // it exists but is not this family, it exists but is another kind entirely,
  // or Premiere simply does not have it.
  function explainMissing(ql, type, meta, all, slotId, node) {
    var outsideFamily = (meta && meta.match)
      ? all.filter(function (n) { return n.toLowerCase().indexOf(ql) !== -1; })
      : [];

    if (outsideFamily.length) {
      var slot = slotById(slotId);
      var box = document.createElement("div");
      box.className = "elsewhere";
      var t = document.createElement("div");
      t.innerHTML = "<b>" + outsideFamily[0] + "</b> is a " + TYPE_LABEL[type] +
        ", but this QuickKey applies " + (meta.family || "a specific group").toLowerCase() + ".";
      box.appendChild(t);
      var n = document.createElement("div");
      n.className = "elsenote";
      n.textContent = "Use \u201c+ add QuickKey\u201d to make one for it.";
      box.appendChild(n);
      var stale = node.querySelector(".nomatch");
      if (stale) stale.parentNode.removeChild(stale);
      node.appendChild(box);
      return;
    }
    lookElsewhere(ql, type, slotId, node);
  }

  function showElsewhere(found, currentType, slotId, node) {
    var stale = node.querySelector(".nomatch");
    if (!found.length) {
      if (stale) stale.innerHTML =
        "Premiere has no " + TYPE_LABEL[currentType] + " by that name." +
        "<br><br>This lists Premiere\u2019s own effects. Presets you saved, Motion Graphics " +
        "templates and Essential Graphics items are not in it, and QuickKey cannot apply them yet.";
      return;
    }
    var slot = slotById(slotId), hit = found[0];
    if (stale) stale.parentNode.removeChild(stale);

    var box = document.createElement("div");
    box.className = "elsewhere";
    var t = document.createElement("div");
    t.innerHTML = "<b>" + hit.name + "</b> is a " + TYPE_LABEL[hit.type] +
                  ", and this QuickKey applies " + TYPE_LABEL[currentType] + "s.";
    box.appendChild(t);

    // Only a QuickKey you created can change what kind of thing it applies.
    if (slot && !templateFor(slot.id)) {
      var act = document.createElement("div");
      act.className = "elseact";
      act.textContent = "Make this a " + TYPE_LABEL[hit.type] + " QuickKey";
      act.onclick = function () {
        mark("change " + slot.label + " to " + hit.type);
        slot.type = hit.type; slot.effect = ""; slot.params = "";
        save(); closePicker(); renderAll(); openPicker(slotId, "");
      };
      box.appendChild(act);
    } else {
      var note = document.createElement("div");
      note.className = "elsenote";
      note.textContent = "Add a QuickKey of that kind to use it.";
      box.appendChild(note);
    }
    node.appendChild(box);
  }

  function drawPicker(q, current) {
    var list = document.getElementById("pickerList");
    list.innerHTML = "";
    var ql = q.toLowerCase();
    var slot = slotById(pickerTarget);
    var type = slot ? slot.type : "video";
    var all = effectCache[type] || [];

    // A blur slot lists blurs and nothing else: if it could hold a Lens
    // Distortion, the row's own label would be a lie. Anything outside the
    // family belongs in a QuickKey of your own.
    var meta = slot ? (templateFor(slot.id) || slot) : null;
    var rx = (meta && meta.match) ? new RegExp(meta.match, "i") : null;
    var shown = rx ? all.filter(function (n) { return rx.test(n); }) : all;
    if (rx && !shown.length) { shown = all; rx = null; }

    // The family header is context for browsing; while searching it is noise,
    // and it also made the list look non-empty when nothing matched.
    if (rx && !ql) {
      var bar = document.createElement("div");
      bar.className = "fxfilter";
      bar.textContent = (meta.family || "Matching") + " \u00b7 " + shown.length;
      list.appendChild(bar);
    }


    shown.forEach(function (name) {
      if (ql && name.toLowerCase().indexOf(ql) === -1) return;
      var d = document.createElement("div");
      d.className = "fx" + (name === current ? " on" : "");
      var fi = document.createElement("span"); fi.className = "fxicon";
      fi.innerHTML = qkIconFor(name, "wand");
      var fl = document.createElement("span"); fl.textContent = name;
      d.appendChild(fi); d.appendChild(fl);
      d.onclick = function () {
        var m = mode();
        mark("change " + pickerTarget + " effect");
        // A new effect invalidates parameters captured from the old one.
        var slotId = pickerTarget;
        var sl = slotById(slotId);
        if (sl) { sl.effect = name; sl.params = ""; }
        closePicker(); save(); renderAll();
        log("set " + slotId + " → " + name, "ok");
      };
      list.appendChild(d);
    });
    if (!list.querySelectorAll(".fx").length) {
      list.innerHTML = "";
      var m = document.createElement("div");
      m.className = "nomatch";
      m.textContent = ql ? "Searching\u2026" : "Nothing to show.";
      list.appendChild(m);
      if (ql) explainMissing(ql, type, meta, all, pickerTarget, list);
    }
  }
  function closePicker(){ document.getElementById("picker").className = "picker"; pickerTarget = null; }

  // Esc alone was too easy to miss. Backspace goes back too, which is safe now
  // that the search box does not take focus when the picker opens.
  document.addEventListener("keydown", function (e) {
    if (!pickerTarget) return;
    if (document.activeElement === document.getElementById("pickerSearch")) return;
    if (e.key === "Backspace" || e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); closePicker();
    }
  }, true);

  document.getElementById("pickerClose").onclick = closePicker;
  document.getElementById("pickerSearch").oninput = function(){
    var m = mode(); drawPicker(this.value, m && m.slots[pickerTarget] ? m.slots[pickerTarget].effect : "");
  };
  document.getElementById("pickerSearch").onkeydown = function(e){
    e.stopPropagation();
    if (e.key === "Escape") { closePicker(); return; }
    if (e.key === "Backspace" && this.value === "") { e.preventDefault(); closePicker(); }
  };

  // ---------- capture ----------
  function capture(slotId, effectName) {
    evalHost("qkProbeParams(" + JSON.stringify(effectName) + ")", function (r) {
      var s = String(r);
      if (s.indexOf("OK|") !== 0) {
        // Failing quietly into the activity log left people guessing.
        var msg = s.replace(/^(QK_)?ERR:\s*/, "");
        log(msg, "bad");
        toast(msg, false);
        flash(slotId, "bad");
        return;
      }
      mark("capture " + effectName + " settings");
      var sl = slotById(slotId);
      if (!sl) { log("that default no longer exists", "bad"); return; }
      sl.effect = effectName; sl.params = s.slice(3);
      save(); renderAll();
      log("captured " + effectName + " settings", "ok");
    });
  }

  // ---------- key assignment ----------
  document.addEventListener("keydown", function (e) {
    // Undo/redo take priority, but never while capturing a key assignment —
    // there, cmd+z is a binding the user is trying to make.
    if (!listening && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (!listening) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") { endArming(); return; }
    if (["Shift","Control","Alt","Meta"].indexOf(e.key) !== -1) return;

    var target = listening;
    armError = null;
    mark("rebind key");
    if (e.key === "Backspace" || e.key === "Delete") {
      if (target.indexOf("mode:") === 0) {
        state.modes.forEach(function(m){ if ("mode:"+m.id===target) m.key = ""; });
      } else delete state.keys[target];
      log("unassigned");
    } else {
      var mods = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.altKey)  mods.push("opt");
      if (e.metaKey) mods.push("cmd");
      if (e.shiftKey)mods.push("shift");
      var k = e.key.toUpperCase();
      if (k.length !== 1 && !/^F\d$/.test(k)) { log("unsupported key: " + e.key, "bad"); return; }
      // A modifier-less hotkey is consumed system-wide and cannot be handed back,
      // which kills that key in every other app. Refuse until we have an event tap.
      if (mods.length === 0) {
        // Previously this only went to the log, so it looked like nothing
        // happened at all. Say it on the row, and stay armed for another try.
        armError = "that key needs Control or Option \u2014 try again";
        log("shortcuts need a modifier: hold Ctrl or Option, then the key", "bad");
        renderAll();
        return;
      }

      if (target.indexOf("mode:") === 0) {
        state.modes.forEach(function(m){ if ("mode:"+m.id===target){ m.key=k; m.mods=mods; } });
      } else {
        state.keys[target] = { key:k, mods:mods };
      }
      log("bound " + combo({ key: k, mods: mods }), "ok");
    }
    save(); endArming();
  }, true);

  // ---------- bridge ----------
  var lastId = (function(){ var r = readFile(REQ); try { return JSON.parse(r.data).id; } catch(e){ return null; } })();
  setInterval(function () {
    var r = readFile(REQ);
    if (r.err !== 0 || !r.data) return;
    var req; try { req = JSON.parse(r.data); } catch(e){ return; }
    if (!req || req.id === lastId) return;
    lastId = req.id;

    // Mode switches are handled here, in the panel — they change QuickKey's own
    // state, so they never reach Premiere.
    if (String(req.code).indexOf("QK_MODE:") === 0) {
      var id = String(req.code).slice(8).replace(/^\s+|\s+$/g, "");
      switchMode(id);
      writeFile(RES, JSON.stringify({ id:req.id, result:"OK: mode "+mode().name, t:Date.now() }));
      flash("mode:"+id, "fired");
      return;
    }

    var hit = null, hitLabel = null;
    buildBindings().forEach(function (b) { if (b.script === req.code) { hit = b.id; hitLabel = b.label; } });

    evalHost(req.code, function (result) {
      writeFile(RES, JSON.stringify({ id:req.id, result:result, t:Date.now() }));
      var bad = String(result).indexOf("QK_ERR")===0 || String(result).indexOf("ERR:")===0 ||
                result === "EvalScript error.";
      if (hit) flash(hit, bad ? "bad" : "fired");
      log(String(result).slice(0,160), bad ? "bad" : "ok");
    });
  }, 200);

  setInterval(function(){ writeFile(BEAT, JSON.stringify({t:Date.now()})); }, 2000);
  writeFile(BEAT, JSON.stringify({t:Date.now()}));

  // Dev hook — lets the harness inspect panel internals without a debugger UI.
  window.__qk = {
    listening: function () { return listening; },
    history:   function () { return history.map(function (h) { return h.desc; }); },
    future:    function () { return future.length; },
    undo: undo, redo: redo
  };

  // ---------- boot ----------
  loadConfig(); seedNewActions(); scrubParams(); save();
  helpOpen = !state.helpSeen;   // first run explains itself
  renderHelp(); renderAll();
  evalHost("$.evalFile(File(" + JSON.stringify(HOSTJSX) + ")); app.setExtensionPersistent('com.quickkey.dev.panel',1); 'ready ' + app.version",
    function (v) {
      document.getElementById("dot").className = "on";
      document.getElementById("statusText").textContent =
        "v" + QK_VERSION + " \u00b7 Premiere " + String(v).replace("ready ","");
      log(String(v), "ok");
    });
})();
