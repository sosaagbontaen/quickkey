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
  { id:"blur",       label:"Add Default Blur",       icon:"blur",   type:"video",      defaultKey:"B", fallback:"Gaussian Blur" },
  { id:"grade",      label:"Add Default Grade",      icon:"grade",  type:"video",      defaultKey:"G", fallback:"Lumetri Color" },
  { id:"transition", label:"Add Default Transition", icon:"trans",  type:"transition", defaultKey:"T", fallback:"Cross Dissolve" },
  { id:"audiofx",    label:"Add Default Audio FX",   icon:"audio",  type:"audio",      defaultKey:"A", fallback:"Parametric Equalizer" },
  { id:"sharpen",    label:"Add Sharpen",            icon:"sharp",  type:"video",      defaultKey:"S", fallback:"Sharpen" },
  { id:"dropshadow", label:"Add Drop Shadow",        icon:"shadow", type:"video",      defaultKey:"",  fallback:"Drop Shadow" },
  { id:"transform",  label:"Add Transform",          icon:"xform",  type:"video",      defaultKey:"",  fallback:"Transform" },
  { id:"crop",       label:"Add Crop",               icon:"crop",   type:"video",      defaultKey:"",  fallback:"Crop" },
  { id:"lens",       label:"Add Lens Distortion",    icon:"lens",   type:"video",      defaultKey:"",  fallback:"Lens Distortion" }
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
