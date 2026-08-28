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
  function slotCfg(slot) { return slot; }
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
    apply(h.data); save(); render();
    log("undid: " + h.desc, "ok");
  }
  function redo() {
    if (!future.length) { log("nothing to redo"); return; }
    var f = future.pop();
    history.push({ desc: f.desc, data: snap() });
    apply(f.data); save(); render();
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
    var out = { onlyWhenFrontmost:GATE, activeMode:state.activeMode,
                modes:state.modes, keys:state.keys, bindings:buildBindings() };
    var json = JSON.stringify(out, null, 2);
    if (writeFile(CONFIG, json).err !== 0) log("could not write config", "bad");
    backup(json);
  }

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
    return (k.mods||[]).map(function(x){ return {ctrl:"⌃",opt:"⌥",cmd:"⌘",shift:"⇧"}[x]||x; }).join("") + k.key;
  }

  function chipFor(id, keyObj, onAssign) {
    var c = document.createElement("div");
    var t = combo(keyObj);
    c.className = "chip" + (t ? "" : " empty");
    c.textContent = listening === id ? "?" : (t || "—");
    c.title = "Click, then press a key. Backspace clears.";
    c.onclick = function(e){ e.stopPropagation(); listening = (listening===id?null:id); render(); };
    return c;
  }

  function groupHead(title, note, addable) {
    var g = document.createElement("div"); g.className = "group";
    var a = document.createElement("span"); a.textContent = title; g.appendChild(a);
    if (note) { var b = document.createElement("em"); b.textContent = note; g.appendChild(b); }
    if (addable) {
      var plus = document.createElement("em");
      plus.className = "addslot"; plus.textContent = "+ add default";
      plus.onclick = openSlotAdd;
      g.appendChild(plus);
    }
    elList.appendChild(g);
  }

  function render() {
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
      ic.innerHTML = QK_ICON[s.icon] || ""; row.appendChild(ic);

      var body = document.createElement("div"); body.className = "body";
      var lb = document.createElement("div"); lb.className = "label"; lb.textContent = s.label;
      var sub = document.createElement("div");
      sub.className = "sub" + (cfg.effect ? "" : " unset");
      sub.textContent = cfg.effect || "choose an effect…";
      sub.onclick = function(e){ e.stopPropagation(); openPicker(s.id, cfg.effect); };
      body.appendChild(lb); body.appendChild(sub);

      if (cfg.effect && s.type === "video") {
        var n = parseParams(cfg.params).length;
        var badge = document.createElement("div");
        badge.className = "settings" + (n ? "" : " none");
        badge.textContent = n
          ? (expanded === s.id ? "▾ " : "▸ ") + n + " setting" + (n===1?"":"s") + " captured"
          : "default settings — nothing captured";
        if (n) badge.onclick = function (e) {
          e.stopPropagation(); expanded = (expanded === s.id) ? null : s.id; render();
        };
        body.appendChild(badge);
      }
      row.appendChild(body);

      if (s.type !== "video") {
        var pill = document.createElement("div");
        pill.className = "tpill";
        pill.textContent = (s.type === "audio" ? "audio" : "trans");
        row.appendChild(pill);
      }
      // Only video effects expose tunable parameters we can capture.
      if (cfg.effect && s.type === "video") {
        var cap = document.createElement("div");
        cap.className = "cap"; cap.textContent = "capture";
        cap.title = "Store the settings from the selected clip as this default";
        cap.onclick = function(e){ e.stopPropagation(); capture(s.id, cfg.effect); };
        row.appendChild(cap);
      }
      // Any default can be removed, core ones included — they are only a starting
      // point. Removal is scoped to this mode; other modes keep theirs.
      var rm = document.createElement("div");
      rm.className = "rmslot"; rm.textContent = "\u00d7";
      rm.title = "Remove from " + (m ? m.name : "this mode");
      rm.onclick = function (e) {
        e.stopPropagation();
        confirmThen("Remove \u201c" + s.label + "\u201d from \u201c" + (m ? m.name : "") + "\u201d?", "Remove", function () {
          mark("remove \u201c" + s.label + "\u201d from " + (m ? m.name : ""));
          var md = mode();
          md.slots = md.slots.filter(function (x) { return x.id !== s.id; });
          save(); render();
          log("removed \u201c" + s.label + "\u201d — \u2318Z to undo", "ok");
        });
      };
      row.appendChild(rm);
      row.title = "Click to run this now";
      row.onclick = function () { runCommand(s.id, s.effect ? scriptFor(s, s) : "", s.label); };
      elList.appendChild(row);

      if (expanded === s.id && cfg.params) {
        var det = document.createElement("div"); det.className = "details";
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
        var clear = document.createElement("div");
        clear.className = "clearparams";
        clear.textContent = "Clear captured settings — use the effect's own defaults";
        clear.onclick = function () {
          mark("clear captured settings"); s.params = "";
          expanded = null; save(); render(); log("cleared captured settings", "ok");
        };
        det.appendChild(clear);
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
      row.title = "Click to run this now";
      row.onclick = function () { runCommand(a.id, a.script, a.label); };
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
    });
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
    render();
    log("mode → " + mode().name, "ok");
  }

  document.getElementById("modeSelect").onchange = function(){ switchMode(this.value); };
  document.getElementById("modeAdd").onclick = function () {
    var w = document.getElementById("modeNameWrap");
    w.className = "newmode show";
    var i = document.getElementById("modeName"); i.value = ""; i.focus();
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
    save(); render(); log("created mode '" + name + "'", "ok");
  };
  document.getElementById("modeDel").onclick = function () {
    if (state.modes.length < 2) { log("keep at least one mode", "bad"); return; }
    var m = mode(); if (!m) return;
    confirmThen("Delete mode \u201c" + m.name + "\u201d? Its effect defaults go with it.", "Delete", function () {
      mark("delete mode \u201c" + m.name + "\u201d");
      state.modes = state.modes.filter(function (x) { return x.id !== m.id; });
      state.activeMode = state.modes[0].id;
      save(); render();
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
    var i = document.getElementById("slotName"); i.value = ""; i.focus();
  }

  document.getElementById("slotName").onkeydown = function (e) {
    e.stopPropagation();
    if (e.key === "Escape") { document.getElementById("slotAddWrap").className = "newmode"; return; }
    if (e.key !== "Enter") return;
    var name = this.value.trim(); if (!name) return;
    var type = document.getElementById("slotType").value;

    mark("add default \u201c" + name + "\u201d");
    var slot = { id: "s" + Date.now().toString(36), label: name, type: type,
                 icon: type === "audio" ? "audio" : (type === "transition" ? "trans" : "wand"),
                 effect: "", params: "" };
    mode().slots.push(slot);
    document.getElementById("slotAddWrap").className = "newmode";
    save(); render();
    log("added default \u201c" + name + "\u201d — pick its effect, then give it a key", "ok");
  };

  // ---------- effect picker ----------
  function openPicker(slotId, current) {
    pickerTarget = slotId;
    var slot = slotById(slotId);
    var type = slot ? slot.type : "video";
    document.getElementById("pickerTitle").textContent = "Effect for " + (slot ? slot.label : slotId);
    document.getElementById("picker").className = "picker show";
    var box = document.getElementById("pickerSearch"); box.value = ""; box.focus();

    if (effectCache[type]) return drawPicker("", current);
    document.getElementById("pickerList").innerHTML = "<div class='fx'>loading…</div>";
    var cmd = type === "audio" ? "qkListAudioEffects()"
            : type === "transition" ? "qkListTransitions()" : "qkListEffects()";
    evalHost(cmd, function (r) {
      effectCache[type] = String(r).split("|").filter(function (x) { return x && x.indexOf("QK_ERR") !== 0; });
      box.placeholder = "Search " + effectCache[type].length + " " +
        (type === "transition" ? "transitions" : type === "audio" ? "audio effects" : "effects") + "…";
      drawPicker("", current);
    });
  }

  function drawPicker(q, current) {
    var list = document.getElementById("pickerList");
    list.innerHTML = "";
    var ql = q.toLowerCase();
    var slot = slotById(pickerTarget);
    var type = slot ? slot.type : "video";
    (effectCache[type] || []).forEach(function (name) {
      if (ql && name.toLowerCase().indexOf(ql) === -1) return;
      var d = document.createElement("div");
      d.className = "fx" + (name === current ? " on" : "");
      d.textContent = name;
      d.onclick = function () {
        var m = mode();
        mark("change " + pickerTarget + " effect");
        // A new effect invalidates parameters captured from the old one.
        var slotId = pickerTarget;
        var sl = slotById(slotId);
        if (sl) { sl.effect = name; sl.params = ""; }
        closePicker(); save(); render();
        log("set " + slotId + " → " + name, "ok");
      };
      list.appendChild(d);
    });
    if (!list.children.length) list.innerHTML = "<div class='fx'>no match</div>";
  }
  function closePicker(){ document.getElementById("picker").className = "picker"; pickerTarget = null; }
  document.getElementById("pickerClose").onclick = closePicker;
  document.getElementById("pickerSearch").oninput = function(){
    var m = mode(); drawPicker(this.value, m && m.slots[pickerTarget] ? m.slots[pickerTarget].effect : "");
  };
  document.getElementById("pickerSearch").onkeydown = function(e){
    e.stopPropagation();
    if (e.key === "Escape") closePicker();
  };

  // ---------- capture ----------
  function capture(slotId, effectName) {
    evalHost("qkProbeParams(" + JSON.stringify(effectName) + ")", function (r) {
      var s = String(r);
      if (s.indexOf("OK|") !== 0) { log(s, "bad"); return; }
      mark("capture " + effectName + " settings");
      var sl = slotById(slotId);
      if (!sl) { log("that default no longer exists", "bad"); return; }
      sl.effect = effectName; sl.params = s.slice(3);
      save(); render();
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
    if (e.key === "Escape") { listening = null; render(); return; }
    if (["Shift","Control","Alt","Meta"].indexOf(e.key) !== -1) return;

    var target = listening;
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
      if (mods.length === 0) { log("bare keys disabled — hold ctrl/opt/cmd", "bad"); return; }

      if (target.indexOf("mode:") === 0) {
        state.modes.forEach(function(m){ if ("mode:"+m.id===target){ m.key=k; m.mods=mods; } });
      } else {
        state.keys[target] = { key:k, mods:mods };
      }
      log("bound " + mods.map(function(x){return {ctrl:"⌃",opt:"⌥",cmd:"⌘",shift:"⇧"}[x];}).join("") + k, "ok");
    }
    listening = null; save(); render();
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

    var hit = null;
    buildBindings().forEach(function (b) { if (b.script === req.code) hit = b.id; });

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
  loadConfig(); scrubParams(); save(); render();
  evalHost("$.evalFile(File(" + JSON.stringify(HOSTJSX) + ")); app.setExtensionPersistent('com.quickkey.dev.panel',1); 'ready ' + app.version",
    function (v) {
      document.getElementById("dot").className = "on";
      document.getElementById("statusText").textContent = "Premiere " + String(v).replace("ready ","");
      log(String(v), "ok");
    });
})();
