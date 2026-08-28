// QuickKey catalogue.
//
// Two kinds of command:
//   SLOTS   — "Add Default Blur". What they DO is defined per mode, so the same
//             key can mean Gaussian Blur in one mode and Compound Blur in another.
//   ACTIONS — fixed timeline operations. Identical in every mode.

var QK_ICON = {
  blur:   '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="6.2" stroke-dasharray="1.5 2.2"/></svg>',
  grade:  '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 2v12M2.8 5l10.4 6M2.8 11l10.4-6"/></svg>',
  sharp:  '<svg viewBox="0 0 16 16"><path d="M8 2.5 14 13H2z"/></svg>',
  wand:   '<svg viewBox="0 0 16 16"><path d="M3 13 11 5M9.5 3.5 12.5 6.5"/><path d="M13 2v2.4M14.8 3.2h-2.4"/></svg>',
  marker: '<svg viewBox="0 0 16 16"><path d="M4 2h8v12l-4-3.2L4 14z"/></svg>',
  eye:    '<svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  frame:  '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M5.5 7h5M8 7v3"/></svg>',
  cut:    '<svg viewBox="0 0 16 16"><circle cx="4" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M5.2 10.6 12 3M10.8 10.6 4 3"/></svg>',
  strip:  '<svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.6h4V4M4.5 4l.7 9h5.6l.7-9"/></svg>',
  mode:   '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6 8h4"/></svg>'
};

// Built-in slots. `type` decides which catalogue the picker offers and which
// host command runs: a transition attaches to an edit, an audio effect needs an
// audio clip, and only video effects support captured parameters.
var QK_SLOTS = [
  { id:"blur",       label:"Add Default Blur",       icon:"blur",   type:"video",      defaultKey:"B", fallback:"Gaussian Blur", match:"blur", family:"Blurs" },
  { id:"grade",      label:"Add Default Grade",      icon:"grade",  type:"video",      defaultKey:"G", fallback:"Lumetri Color", match:"lumetri|color|curve|level|tint|tone|balance|equaliz", family:"Colour" },
  { id:"transition", label:"Add Default Transition", icon:"trans",  type:"transition", defaultKey:"T", fallback:"Cross Dissolve" },
  { id:"audiofx",    label:"Add Default Audio FX",   icon:"audio",  type:"audio",      defaultKey:"A", fallback:"Parametric Equalizer" },
  { id:"sharpen",    label:"Add Sharpen",            icon:"sharp",  type:"video",      defaultKey:"S", fallback:"Sharpen", match:"sharpen|unsharp", family:"Sharpen" },
  { id:"dropshadow", label:"Add Drop Shadow",        icon:"shadow", type:"video",      defaultKey:"",  fallback:"Drop Shadow", match:"shadow|bevel|glow", family:"Shadow" },
  { id:"transform",  label:"Add Transform",          icon:"xform",  type:"video",      defaultKey:"",  fallback:"Transform", match:"transform|scale|rotat|position|mirror|offset", family:"Transform" },
  { id:"crop",       label:"Add Crop",               icon:"crop",   type:"video",      defaultKey:"",  fallback:"Crop", match:"crop|mask|garbage|matte", family:"Crop" },
  { id:"lens",       label:"Add Lens Distortion",    icon:"lens",   type:"video",      defaultKey:"",  fallback:"Lens Distortion", match:"lens|distort|warp|spheriz|wave|ripple", family:"Distortion" }
];

var QK_SLOT_TYPES = [
  { id:"video",      label:"Video effect" },
  { id:"audio",      label:"Audio effect" },
  { id:"transition", label:"Transition" }
];

// Fixed actions — same in every mode.
var QK_ACTIONS = [
  { id: "marker", label: "Add Marker",         icon: "marker", defaultKey: "M", script: 'qkAddMarker()' },
  { id: "enable", label: "Toggle Clip On/Off", icon: "eye",    defaultKey: "E", script: 'qkToggleEnabled()' },
  { id: "fit",    label: "Scale to Frame",     icon: "frame",  defaultKey: "F", script: 'qkScaleToFrame()' },
  { id: "ripple", label: "Ripple Delete",      icon: "cut",    defaultKey: "D", script: 'qkRippleDelete()' },
  { id: "strip",  label: "Strip All Effects",  icon: "strip",  defaultKey: "X", script: 'qkStripEffects()' }
];

var QK_DEFAULT_MODS = ["ctrl", "opt"];

// Premiere reports enum parameters as bare integers and never exposes the option
// names, so known ones are listed here by parameter name. Anything not listed
// still renders as a dropdown (the probed bounds tell us it is one) but with
// generic labels — better a valid choice than a meaningless 0.22 on a slider.
var QK_ENUM_LABELS = {
  "Edge Behavior": ["Mirrored", "Repeat Edge", "Transparent"]
};

// Internal Premiere properties present on every effect. They are not user
// parameters — "Error occurred" is a status flag, not a fault — and older
// captures stored them before the host learned to skip them.
var QK_HIDDEN_PARAMS = { "Error occurred": 1, "Controls": 1 };

// Icons are matched to the CHOSEN effect, not just the slot, so a row changes
// its face when you repoint it. Order matters — first pattern wins.
var QK_ICON_EXTRA = {
  key:    '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="6" r="3"/><path d="M7.8 8 13 13.2M11 11l1.6-1.6"/></svg>',
  noise:  '<svg viewBox="0 0 16 16"><path d="M2.5 8h1.6M5.7 4.6h1.6M5.7 11.4h1.6M8.9 8h1.6M12.1 5.6h1.6M12.1 10.4h1.6M2.5 11.4h1.2M8.9 4.2h1.2"/></svg>',
  glow:   '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.6"/><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/></svg>',
  text:   '<svg viewBox="0 0 16 16"><path d="M3 3.5h10M8 3.5v9M5.8 12.5h4.4"/></svg>',
  mask:   '<svg viewBox="0 0 16 16"><path d="M8 2.5c3 0 5.5 2.5 5.5 5.5S11 13.5 8 13.5 2.5 11 2.5 8 5 2.5 8 2.5z"/><path d="M8 2.5v11"/></svg>',
  time:   '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.6V8l2.4 1.6"/></svg>',
  stab:   '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.2v2.2M8 12.6v2.2M1.2 8h2.2M12.6 8h2.2"/></svg>',
  vign:   '<svg viewBox="0 0 16 16"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><circle cx="8" cy="8" r="3.2"/></svg>',
  grad:   '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M2.5 10.5h11M2.5 8.2h11" opacity=".55"/></svg>',
  speed:  '<svg viewBox="0 0 16 16"><path d="M2.5 12.5a5.5 5.5 0 1 1 11 0"/><path d="M8 12.5 11 6.6"/></svg>',
  mirror: '<svg viewBox="0 0 16 16"><path d="M8 2v12"/><path d="M6 5 3 8l3 3zM10 5l3 3-3 3"/></svg>'
};
for (var k in QK_ICON_EXTRA) QK_ICON[k] = QK_ICON_EXTRA[k];


// These six never made it into the base map; without them their rows render blank.
QK_ICON.shadow = '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="8" height="8" rx="1"/><path d="M6 13.5h7.5V6"/></svg>';
QK_ICON.xform  = '<svg viewBox="0 0 16 16"><path d="M3 3h4v4H3zM9 9h4v4H9zM7 5h4v4"/></svg>';
QK_ICON.crop   = '<svg viewBox="0 0 16 16"><path d="M4.5 1.5v10h10M1.5 4.5h10v10"/></svg>';
QK_ICON.lens   = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M3.4 5.2c3-1.6 6.2-1.6 9.2 0M3.4 10.8c3 1.6 6.2 1.6 9.2 0"/></svg>';
QK_ICON.audio  = '<svg viewBox="0 0 16 16"><path d="M2 9.5v-3M5 12V4M8 14V2M11 12V4M14 9.5v-3"/></svg>';
QK_ICON.trans  = '<svg viewBox="0 0 16 16"><path d="M2 3h5v10H2zM14 3H9v10h5"/><path d="M7 8h2"/></svg>';

var QK_EFFECT_ICON = [
  [/blur/i,                          "blur"],
  [/sharpen|unsharp/i,               "sharp"],
  [/lumetri|colou?r|tint|levels|curve|balance|cdl|posterize|black *& *white|invert/i, "grade"],
  [/shadow|bevel/i,                  "shadow"],
  [/glow|flare|lightning|light|ray|glint|shine/i, "glow"],
  [/key$|key |chroma|luma|matte|ultra/i, "key"],
  [/crop|garbage/i,                  "crop"],
  [/mask|shape|ellipse/i,            "mask"],
  [/lens|distort|warp|spheriz|wave|ripple|twirl|magnif|bulge/i, "lens"],
  [/mirror|flip/i,                   "mirror"],
  [/transform|scale|rotat|position|offset|corner pin|basic 3d/i, "xform"],
  [/noise|grain|dust|mosaic|median|dither/i, "noise"],
  [/text|title|timecode|clip name|numbers/i, "text"],
  [/time|echo|timewarp|strobe|frame/i, "time"],
  [/speed|remap/i,                   "speed"],
  [/stabiliz|rolling shutter|reframe|track/i, "stab"],
  [/vignette/i,                      "vign"],
  [/gradient|ramp|4-color/i,         "grad"],
  [/dissolve|wipe|zoom|slide|push|iris|page|flip|cube|transition/i, "trans"],
  [/equaliz|reverb|delay|volume|pitch|denoise|dehum|compressor|gain|channel/i, "audio"]
];

function qkIconFor(effectName, fallback) {
  if (effectName) {
    for (var i = 0; i < QK_EFFECT_ICON.length; i++) {
      if (QK_EFFECT_ICON[i][0].test(effectName)) return QK_ICON[QK_EFFECT_ICON[i][1]];
    }
  }
  return QK_ICON[fallback] || QK_ICON.wand;
}

// Row controls are symbols, not labels: the panel competes for the same screen
// space the product exists to reclaim. The eyedropper is the idiom creative
// tools already use for "sample this from the source".
QK_ICON.play = '<svg viewBox="0 0 16 16"><path d="M5 3.4 12.4 8 5 12.6z" fill="currentColor" stroke="none"/></svg>';
QK_ICON.pick = '<svg viewBox="0 0 16 16"><path d="M13.6 2.4a1.9 1.9 0 0 0-2.7 0l-1.2 1.2-.7-.7-1.1 1.1.7.7-5 5V13h2.6l5-5 .7.7 1.1-1.1-.7-.7 1.3-1.2a1.9 1.9 0 0 0 0-2.7z"/></svg>';
