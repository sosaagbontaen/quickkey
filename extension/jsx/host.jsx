// QuickKey — host-side commands (ExtendScript, Premiere Pro).
//
// Premiere exposes two parallel object models. The public DOM knows which clips
// are selected but cannot apply effects; the undocumented QE DOM can apply
// effects but has no concept of selection. Every command below bridges the two:
// find the clip in the public DOM, locate the same clip by track/index in QE,
// then act. Assigned to $.global so definitions survive across evalScript calls,
// which each run in a fresh scope.

$.global.qkFindSelected = function () {
    var seq = app.project.activeSequence;
    if (!seq) return { err: "No active sequence" };
    var sel = seq.getSelection();
    if (!sel || sel.length === 0) return { err: "Nothing selected" };

    var hits = [];
    for (var s = 0; s < sel.length; s++) {
        var kinds = [["video", seq.videoTracks], ["audio", seq.audioTracks]];
        for (var g = 0; g < kinds.length; g++) {
            var tracks = kinds[g][1];
            for (var t = 0; t < tracks.numTracks; t++) {
                var clips = tracks[t].clips;
                for (var c = 0; c < clips.numItems; c++) {
                    if (clips[c].nodeId === sel[s].nodeId) {
                        hits.push({ kind: kinds[g][0], track: t, index: c,
                                    clip: clips[c], name: clips[c].name });
                    }
                }
            }
        }
    }
    if (hits.length === 0) return { err: "Selection is not on a track we can reach" };
    return { hits: hits, seq: seq };
};

$.global.qkOfKind = function (hits, kind) {
    var out = [];
    for (var i = 0; i < hits.length; i++) if (hits[i].kind === kind) out.push(hits[i]);
    return out;
};

// Locating the same clip in the QE DOM is the sharpest edge in this codebase.
// QE tracks include empty gaps as items; the public DOM's clips collection does
// not. So the two collections share no index space the moment a timeline has a
// gap anywhere before the clip, and index-based lookup silently targets a
// neighbour. Match on timeline position instead, confirmed by name.
$.global.qkQEItem = function (hit) {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    var track = (hit.kind === "audio") ? qs.getAudioTrackAt(hit.track)
                                       : qs.getVideoTrackAt(hit.track);
    var want = hit.clip.start.seconds;
    var EPS = 0.02;                       // a couple of frames of tolerance

    var named = null, positional = null, bestDiff = EPS;
    for (var i = 0; i < track.numItems; i++) {
        var it = track.getItemAt(i), st;
        try { st = parseFloat(it.start.secs); } catch (e) { continue; }
        if (st !== st) continue;
        var d = Math.abs(st - want);
        if (d > EPS) continue;
        if (it.name === hit.name && named === null) named = it;
        if (d <= bestDiff) { bestDiff = d; positional = it; }
    }
    // Name agreement is the strongest signal; position alone still beats index.
    return named || positional || track.getItemAt(hit.index);
};

$.global.qkApplyEffect = function (effectName) {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    app.enableQE();
    var fx = qe.project.getVideoEffectByName(effectName);
    if (!fx) return "ERR: no effect named '" + effectName + "'";
    var done = [];
    for (var i = 0; i < f.hits.length; i++) {
        if (qkQEItem(f.hits[i]).addVideoEffect(fx)) done.push(f.hits[i].name);
    }
    return "OK: " + effectName + " -> " + done.length + " clip(s)";
};

$.global.qkStripEffects = function () {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;

    // QE's removeEffects() only works on video — on an audio clip it returns
    // true and does nothing. Removing components individually works for both.
    // Intrinsics cannot be removed and must be skipped.
    var KEEP = { "Opacity":1, "Motion":1, "Time Remapping":1,
                 "Volume":1, "Channel Volume":1, "Panner":1 };
    var removed = 0;
    for (var i = 0; i < f.hits.length; i++) {
        var it = qkQEItem(f.hits[i]);
        // Back to front: removing a component reindexes the ones after it.
        for (var j = it.numComponents - 1; j >= 0; j--) {
            var c = it.getComponentAt(j);
            if (!c || KEEP[c.name]) continue;
            try { if (c.remove()) removed++; } catch (e) {}
        }
    }
    return removed ? "OK: removed " + removed + " effect(s)"
                   : "OK: nothing to remove";
};

$.global.qkRippleDelete = function () {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    // Delete back-to-front: removing a clip reindexes everything after it.
    var hits = f.hits.slice().sort(function (a, b) { return b.index - a.index; });
    var n = 0;
    for (var i = 0; i < hits.length; i++) {
        if (qkQEItem(hits[i]).rippleDelete()) n++;
    }
    return "OK: ripple deleted " + n + " clip(s)";
};

$.global.qkAddMarker = function () {
    var seq = app.project.activeSequence;
    if (!seq) return "ERR: No active sequence";
    var t = seq.getPlayerPosition();
    seq.markers.createMarker(t.seconds);
    return "OK: marker at " + t.seconds.toFixed(2) + "s";
};

$.global.qkToggleEnabled = function () {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var state = null;
    for (var i = 0; i < f.hits.length; i++) {
        var c = f.hits[i].clip;
        if (state === null) state = !c.disabled;
        c.disabled = state;
    }
    return "OK: clip(s) " + (state ? "disabled" : "enabled");
};

$.global.qkScaleToFrame = function () {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var n = 0;
    for (var i = 0; i < f.hits.length; i++) {
        var it = qkQEItem(f.hits[i]);
        try { it.setScaleToFrameSize(true); n++; } catch (e) { return "ERR: setScaleToFrameSize unavailable (" + e + ")"; }
    }
    return "OK: scaled " + n + " clip(s) to frame";
};

$.global.qkWorkspace = function (name) {
    app.setWorkspace(name);
    return "OK: workspace -> " + name;
};

// ---------------------------------------------------------------------------
// Effect presets.
//
// Parameters are stored as a flat "Name=value|Name=value" string rather than
// JSON — this ExtendScript engine has no reliable JSON, and every value we care
// about is a scalar. Properties Premiere marks internal (leading underscore or
// blank name) are skipped: they carry sequence geometry, not user intent.
// ---------------------------------------------------------------------------

$.global.qkListEffects = function () {
    app.enableQE();
    var l = qe.project.getVideoEffectList();
    var out = [];
    for (var i = 0; i < l.length; i++) out.push(l[i]);
    return out.join("|");
};

$.global.qkSerializeParams = function (component) {
    var out = [], p = component.properties;
    for (var i = 0; i < p.numItems; i++) {
        var n = p[i].displayName;
        if (!n || n.charAt(0) === "_") continue;
        // Bookkeeping Premiere exposes on every effect — not user intent.
        if (n === "Error occurred" || n === "Controls") continue;
        var v;
        try { v = p[i].getValue(); } catch (e) { continue; }
        if (typeof v !== "number" && typeof v !== "boolean") continue;
        out.push(n + "=" + v);
    }
    return out.join("|");
};

// Grabs the effect the editor has already dialled in on the selected clip, so a
// default is captured by example instead of typed into a form.
$.global.qkCaptureFrom = function (effectName) {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var comps = f.hits[0].clip.components, found = null;
    for (var i = 0; i < comps.numItems; i++) {
        if (comps[i].displayName === effectName) found = comps[i];   // last wins
    }
    if (!found) return "ERR: no " + effectName + " on the selected clip. Add it, set it how you like, then capture.";
    return "OK|" + qkSerializeParams(found);
};

$.global.qkReadEffectsOn = function () {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var comps = f.hits[0].clip.components, out = [];
    for (var i = 0; i < comps.numItems; i++) {
        var n = comps[i].displayName;
        if (n !== "Motion" && n !== "Opacity" && n !== "Time Remapping") out.push(n);
    }
    return out.length ? "OK|" + out.join("|") : "ERR: no effects on the selected clip";
};

$.global.qkApplyPreset = function (effectName, paramStr) {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    app.enableQE();
    var fx = qe.project.getVideoEffectByName(effectName);
    if (!fx) return "ERR: no effect named '" + effectName + "'";

    var hits = qkOfKind(f.hits, "video");
    if (!hits.length) return "ERR: select a video clip";
    var applied = 0, tuned = 0, failed = [];
    for (var h = 0; h < hits.length; h++) {
        var item = qkQEItem(hits[h]);
        if (!item || !item.name) { failed.push(hits[h].name + " (could not locate it on the track)"); continue; }
        if (!item.addVideoEffect(fx)) { failed.push(hits[h].name + " (Premiere refused the effect)"); continue; }
        applied++;
        if (!paramStr) continue;

        // Tune the instance we just added — the last one carrying this name.
        var comps = hits[h].clip.components, target = null;
        for (var i = 0; i < comps.numItems; i++) {
            if (comps[i].displayName === effectName) target = comps[i];
        }
        if (!target) continue;

        var pairs = paramStr.split("|");
        for (var k = 0; k < pairs.length; k++) {
            var eq = pairs[k].lastIndexOf("=");
            if (eq < 1) continue;
            var name = pairs[k].substring(0, eq), raw = pairs[k].substring(eq + 1);
            raw = raw.split("~")[0];                  // strip probed bounds
            var val = (raw === "true") ? true : (raw === "false") ? false : parseFloat(raw);
            if (val !== val) continue;                     // NaN guard
            for (var j = 0; j < target.properties.numItems; j++) {
                if (target.properties[j].displayName === name) {
                    try { target.properties[j].setValue(val, true); tuned++; } catch (e) {}
                    break;
                }
            }
        }
    }
    if (!applied) return "ERR: " + effectName + " not applied \u2014 " + failed.join("; ");
    var msg = "OK: " + effectName + " -> " + applied + " clip(s)" + (tuned ? " (" + tuned + " params set)" : "");
    if (failed.length) msg += "  [skipped: " + failed.join("; ") + "]";
    return msg;
};

// Premiere never reports a parameter's range, but it does clamp: write a value
// far outside the range and read back the bound. Two writes per property gives
// real minimums and maximums. Parameter writes create no undo entries, so this
// costs the user nothing, and the original value is restored afterwards.
$.global.qkProbeParams = function (effectName) {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var comps = f.hits[0].clip.components, target = null;
    for (var i = 0; i < comps.numItems; i++) {
        if (comps[i].displayName === effectName) target = comps[i];
    }
    if (!target) return "ERR: '" + effectName + "' is not on the selected clip";

    var BIG = 1e9, out = [], props = target.properties;
    for (var j = 0; j < props.numItems; j++) {
        var n = props[j].displayName;
        if (!n || n.charAt(0) === "_" || n === "Error occurred" || n === "Controls") continue;

        var orig;
        try { orig = props[j].getValue(); } catch (e) { continue; }
        if (typeof orig === "boolean") { out.push(n + "=" + orig + "~bool"); continue; }
        if (typeof orig !== "number") continue;

        var lo = "", hi = "";
        try {
            props[j].setValue(-BIG, true); lo = props[j].getValue();
            props[j].setValue(BIG, true);  hi = props[j].getValue();
            props[j].setValue(orig, true);
        } catch (e) {
            try { props[j].setValue(orig, true); } catch (e2) {}
            out.push(n + "=" + orig); continue;
        }
        out.push(n + "=" + orig + "~" + lo + "~" + hi);
    }
    return "OK|" + out.join("|");
};

$.global.qkApplyAudioEffect = function (effectName) {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var hits = qkOfKind(f.hits, "audio");
    if (!hits.length) return "ERR: select an audio clip";
    app.enableQE();
    var fx = qe.project.getAudioEffectByName(effectName);
    if (!fx) return "ERR: no audio effect named '" + effectName + "'";
    var n = 0;
    for (var i = 0; i < hits.length; i++) if (qkQEItem(hits[i]).addAudioEffect(fx)) n++;
    return "OK: " + effectName + " -> " + n + " audio clip(s)";
};

// Transitions attach to a clip edge, not to the clip body, so this lands one at
// the head of each selected clip — the cut the editor is sitting on.
$.global.qkApplyTransition = function (name) {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    app.enableQE();
    var n = 0;
    for (var i = 0; i < f.hits.length; i++) {
        var h = f.hits[i];
        var tr = (h.kind === "audio") ? qe.project.getAudioTransitionByName(name)
                                      : qe.project.getVideoTransitionByName(name);
        if (!tr) continue;
        try { if (qkQEItem(h).addTransition(tr, true)) n++; } catch (e) {}
    }
    if (!n) return "ERR: could not add '" + name + "'";
    return "OK: " + name + " -> " + n + " edit(s)";
};

$.global.qkListAudioEffects = function () {
    app.enableQE();
    var l = qe.project.getAudioEffectList(), o = [];
    for (var i = 0; i < l.length; i++) o.push(l[i]);
    return o.join("|");
};

$.global.qkListTransitions = function () {
    app.enableQE();
    var l = qe.project.getVideoTransitionList(), o = [];
    for (var i = 0; i < l.length; i++) o.push(l[i]);
    return o.join("|");
};

// ---------------------------------------------------------------------------
// Un-nest.
//
// Premiere can nest a sequence but offers no way back; the manual route is to
// open the nest, copy, delete, and paste. There is no unnest command to call,
// so this rebuilds the contents in place.
//
// The one non-obvious mechanic: a track item's inPoint/outPoint can be set, but
// setting them does not retime the clip on the timeline. The source project
// item's in/out must be set BEFORE overwriteClip, so the clip arrives already
// the right length. Those are restored afterwards.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Component capture and restore.
//
// Placing a clip with overwriteClip gives you the media and nothing else: no
// effects, and Motion/Opacity back at their defaults. Un-nesting therefore has
// to carry a clip's whole component stack across by hand.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Single-step undo for multi-step commands.
//
// Un-nest is many Premiere operations, and Premiere exposes no way to group
// them into one undo entry - only undo(), redo() and undoStackIndex(). So we
// watch for the user's first ctrl-z and finish the job ourselves.
//
// Deliberately narrow: armed only while our command is the most recent thing
// that happened, and it expires. If anything else is done first, Premiere
// behaves exactly as it normally would.
// ---------------------------------------------------------------------------

$.global.qkUndoWatch = null;

$.global.qkArmUndoCollapse = function (steps, label) {
    if (!steps || steps < 2) return;
    app.enableQE();
    $.global.qkUndoWatch = {
        at:    qe.project.undoStackIndex(),
        steps: steps,
        label: label,
        until: (new Date()).getTime() + 30000
    };
    app.setTimeout(qkUndoTick, 250);
};

$.global.qkUndoTick = function () {
    var w = $.global.qkUndoWatch;
    if (!w) return;
    if ((new Date()).getTime() > w.until) { $.global.qkUndoWatch = null; return; }

    app.enableQE();
    var now = qe.project.undoStackIndex();

    if (now === w.at) { app.setTimeout(qkUndoTick, 250); return; }  // nothing yet
    $.global.qkUndoWatch = null;                                     // one shot either way
    if (now > w.at) return;                                          // they did something else
    if (now !== w.at - 1) return;                                    // they undid past us

    for (var i = 0; i < w.steps - 1; i++) qe.project.undo();
};

$.global.qkIntrinsic = { "Motion":1, "Opacity":1, "Time Remapping":1,
                         "Volume":1, "Channel Volume":1, "Panner":1 };

$.global.qkCaptureComponents = function (clip) {
    var out = [];
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i], name = comp.displayName;
        if (!name) continue;
        var entry = { name: name, intrinsic: !!qkIntrinsic[name], props: [] };
        for (var j = 0; j < comp.properties.numItems; j++) {
            var pr = comp.properties[j], pn = pr.displayName;
            if (!pn || pn.charAt(0) === "_" || pn === "Error occurred" || pn === "Controls") continue;

            var rec = { name: pn, value: null, keys: [] };
            try { rec.value = pr.getValue(); } catch (e) { continue; }
            if (typeof rec.value !== "number" && typeof rec.value !== "boolean") continue;

            // Keyframes are the whole point for things like a slow zoom.
            try {
                if (pr.isTimeVarying()) {
                    var ks = pr.getKeys();
                    for (var k = 0; k < ks.length; k++) {
                        var v = pr.getValueAtKey(ks[k]);
                        if (typeof v === "number" || typeof v === "boolean")
                            rec.keys.push({ t: ks[k].seconds, v: v });
                    }
                }
            } catch (e) {}
            entry.props.push(rec);
        }
        out.push(entry);
    }
    return out;
};

$.global.qkRestoreComponents = function (clip, hit, captured) {
    app.enableQE();
    var restored = 0, T = function (sec) { var t = new Time(); t.seconds = sec; return t; };

    for (var c = 0; c < captured.length; c++) {
        var entry = captured[c], target = null;

        if (entry.intrinsic) {
            for (var i = 0; i < clip.components.numItems; i++)
                if (clip.components[i].displayName === entry.name) target = clip.components[i];
        } else {
            var fx = qe.project.getVideoEffectByName(entry.name);
            if (!fx) continue;
            if (!qkQEItem(hit).addVideoEffect(fx)) continue;
            // The instance we just added is the last one carrying this name.
            for (var m = 0; m < clip.components.numItems; m++)
                if (clip.components[m].displayName === entry.name) target = clip.components[m];
            restored++;
        }
        if (!target) continue;

        for (var p = 0; p < entry.props.length; p++) {
            var rec = entry.props[p], prop = null;
            for (var q = 0; q < target.properties.numItems; q++)
                if (target.properties[q].displayName === rec.name) { prop = target.properties[q]; break; }
            if (!prop) continue;

            try {
                if (rec.keys && rec.keys.length) {
                    prop.setTimeVarying(true);
                    for (var k = 0; k < rec.keys.length; k++) {
                        prop.addKey(T(rec.keys[k].t));
                        prop.setValueAtKey(T(rec.keys[k].t), rec.keys[k].v, true);
                    }
                } else {
                    prop.setValue(rec.value, true);
                }
            } catch (e) {}
        }
    }
    return restored;
};

// Finds a clip by where it sits, since indexes shift as we place things.
$.global.qkClipAt = function (track, seconds) {
    for (var i = 0; i < track.clips.numItems; i++) {
        if (Math.abs(track.clips[i].start.seconds - seconds) < 0.02) return { clip: track.clips[i], index: i };
    }
    return null;
};

$.global.qkFindSequenceFor = function (projectItem) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        if (s.projectItem && s.projectItem.nodeId === projectItem.nodeId) return s;
    }
    return null;
};

$.global.qkUnnest = function () {
    var f = qkFindSelected();
    if (f.err) return "ERR: " + f.err;
    var hits = qkOfKind(f.hits, "video");
    if (!hits.length) return "ERR: select a nested sequence on a video track";

    // Pick the nested sequence out of the selection rather than assuming it is
    // first: selecting a nest often leaves other clips selected too.
    var hit = null;
    for (var h = 0; h < hits.length; h++) {
        var pi = hits[h].clip.projectItem;
        if (pi && pi.isSequence()) { hit = hits[h]; break; }
    }
    if (!hit) return "ERR: nothing in the selection is a nested sequence";
    var nest = hit.clip;

    var src = qkFindSequenceFor(nest.projectItem);
    if (!src) return "ERR: could not find the sequence behind this nest";

    var seq = app.project.activeSequence;
    var undoBefore = qe.project.undoStackIndex();
    var nestStart = nest.start.seconds,
        nestEnd   = nest.end.seconds,
        nestIn    = nest.inPoint.seconds;

    // Work out every placement before touching the timeline.
    var plan = [], skipped = 0;
    for (var t = 0; t < src.videoTracks.numTracks; t++) {
        var clips = src.videoTracks[t].clips;
        for (var j = 0; j < clips.numItems; j++) {
            var ic = clips[j];
            var ts = nestStart + (ic.start.seconds - nestIn);
            var te = nestStart + (ic.end.seconds - nestIn);
            // A trimmed nest hides part of its contents; do not resurrect it.
            if (te <= nestStart + 0.001 || ts >= nestEnd - 0.001) { skipped++; continue; }
            var headTrim = (ts < nestStart) ? (nestStart - ts) : 0;
            var tailTrim = (te > nestEnd) ? (te - nestEnd) : 0;
            plan.push({
                track: hit.track + t,
                pi:    ic.projectItem,
                at:    ts + headTrim,
                inP:   ic.inPoint.seconds + headTrim,
                outP:  ic.outPoint.seconds - tailTrim,
                name:  ic.name,
                comps: qkCaptureComponents(ic)
            });
        }
    }
    if (!plan.length) return "ERR: that nest has nothing on its video tracks";

    // Count only tracks that actually carry something: a nest routinely has
    // empty upper tracks, and requiring room for those would refuse needlessly.
    var needed = 0;
    for (var q = 0; q < plan.length; q++) if (plan[q].track + 1 > needed) needed = plan[q].track + 1;
    if (needed > seq.videoTracks.numTracks)
        return "ERR: this nest needs " + needed + " video tracks and the sequence has " +
               seq.videoTracks.numTracks + ". Add " + (needed - seq.videoTracks.numTracks) + " and try again.";

    // Remove the nest first so its space is free to write into.
    qkQEItem(hit).remove(false, false);

    var placed = 0, fxRestored = 0, failed = [];
    for (var p = 0; p < plan.length; p++) {
        var item = plan[p];
        var keepIn = null, keepOut = null;
        try { keepIn = item.pi.getInPoint(); keepOut = item.pi.getOutPoint(); } catch (e) {}
        try {
            item.pi.setInPoint(item.inP, 4);
            item.pi.setOutPoint(item.outP, 4);
            seq.videoTracks[item.track].overwriteClip(item.pi, item.at);
            placed++;

            // overwriteClip gives us bare media; rebuild the stack we captured.
            var landed = qkClipAt(seq.videoTracks[item.track], item.at);
            if (landed) {
                fxRestored += qkRestoreComponents(landed.clip,
                    { kind: "video", track: item.track, index: landed.index,
                      clip: landed.clip, name: landed.clip.name },
                    item.comps);
            }
        } catch (e) {
            failed.push(item.name);
        }
        // Leave the source clip's in/out as we found it.
        try {
            if (keepIn !== null)  item.pi.setInPoint(keepIn.seconds, 4);
            if (keepOut !== null) item.pi.setOutPoint(keepOut.seconds, 4);
        } catch (e) {}
    }

    var msg = "OK: unnested " + placed + " clip(s)";
    if (fxRestored) msg += ", " + fxRestored + " effect(s) kept";
    if (skipped) msg += ", " + skipped + " outside the trim";
    if (failed.length) msg += "  [failed: " + failed.join(", ") + "]";
    qkArmUndoCollapse(qe.project.undoStackIndex() - undoBefore, "un-nest");
    return msg;
};

"host.jsx loaded";
