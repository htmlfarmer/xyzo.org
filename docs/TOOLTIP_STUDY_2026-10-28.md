# Tooltip / Hover Study — 2026-10-28

A survey of every hover interaction on the Xyzo map, what each one shows,
what is missing, and the design we shipped in response.

## 1. Inventory — what exists today

### Flat map (Leaflet)

| Surface | Trigger | What you see | Verdict |
|---|---|---|---|
| **Canvas story pins** | hover | a glowing circle ("ghost") follows the pin — **no text at all** | ❌ the biggest gap: you cannot preview a headline without clicking |
| Canvas story pins | click | full popup (headline, image, actions, story tree) | ✅ good |
| Story-link arcs | hover | sticky tooltip: both headlines + "why connected" + place | ✅ good |
| Cluster/density circles | hover | "N pins in City (max M)" | ✅ good (debug tool) |
| River labels | always | permanent name labels for rank ≤ 4 rivers | ✅ good |
| Magnetic line labels | always | permanent D/I values, thicker agonic/aclinic | ✅ good |
| Isobar labels | always | value labels along the lines, zoom-gated | ✅ good |
| **Köppen probe** | hover (layer on) | floating box: class code + description | ✅ good |
| **Temperature probe** | hover (layer on) | floating box: °C / °F | ✅ good |
| **Wind probe** | hover (layer on) | floating box: speed + "from" direction | ✅ good |
| **Soil probe** | hover (Probe armed) | floating box: property value | 🟡 click-to-arm only |
| **Magnetic probe** | hover (Probe armed) | floating box: D · I · ΔD · ΔI | 🟡 click-to-arm only |
| **Geology probe** | click (Probe armed) | floating box: unit name/age (network fetch) | 🟡 click-to-arm, by design |
| **Basin probe** | click (Probe armed) | popup: basin name + area | 🟡 click-to-arm (ray-cast is expensive) |
| City mentions in popups | hover | native `title` tooltip: "City, CC · pop N" | 🟡 browser-default style |
| Coordinates under cursor | — | **nothing** | ❌ missing |
| Pins on the 3D globe | click | popup | ❌ no hover preview |

### The problems this study found

1. **No pin hover text.** The single most valuable hover — "what is this
   story?" — gives you only a glowing circle. Every user must click to
   read a headline. This is the #1 gap.
2. **No coordinate readout.** Power users (and the click-to-submit flow)
   have no way to see where the cursor is.
3. **Probe boxes multiply.** Enable climate + temperature + wind and
   three separate boxes fight for the same 14 px offset from the cursor.
4. **Inconsistent arming.** Climate/temp/wind read on hover as soon as
   the layer is on; soil/mag/geology/basin require pressing a "Probe"
   button first — the rule is invisible until you discover it.
5. **No user control.** Nobody can choose what hover does; there is no
   "quiet mode" either.

## 2. What research says is best

- **Preview on hover, detail on click.** Hover answers "is this what I
  want?" in <100 ms; click commits. Google Maps, Mapbox Studio and
  Windy all follow this.
- **One readout, not many.** Windy's model: a single card near the
  cursor aggregates every active layer. Stacked boxes read as noise.
- **Coordinates are a power feature, not a default.** Google Maps hides
  them behind a setting; OSM shows them in a corner. Either way they
  must not compete with the content preview.
- **Quiet mode matters.** Presenters, screenshots and large monitors
  benefit from "nothing follows my cursor".

## 3. The design we shipped

A single **hover HUD** (`public_html/hover-info.js`) with three modes,
selectable in the control menu (⚙ → MAP → Hover) and persisted in
`localStorage["xyzo.hoverMode"]`:

| Mode | Pin hover | Coordinates | Layer readings |
|---|---|---|---|
| **Off** | — | — | layer probes behave exactly as before |
| **Pins** (default) | headline + place + time + sources card | — | layer probes as before |
| **Everything** | same card | lat/lng + zoom line, always visible | one consolidated card: every **enabled, in-memory** layer (climate, temperature, wind, soil, magnetic) sampled at the cursor — the layers' own hover boxes are suppressed so nothing stacks |

Design rules:

- **The pin card is the default.** It answers the #1 gap without any
  other behaviour changing.
- **"Everything" replaces, never stacks.** While the HUD is in
  Everything mode it suppresses the hover-path probe boxes of the
  layers it aggregates (`HoverInfo.suppressesProbes()`); click-armed
  probes (basin, geology) are untouched because those are deliberate
  actions, not hover.
- **Expensive layers stay out of hover.** Geology is a network fetch;
  basin is a 650k-vertex ray-cast. Both keep their Probe-button flow.
- **The HUD never steals clicks** (`pointer-events: none`) and hides
  while the map is being dragged.

### What each mode looks like

```
Off          →  nothing follows the cursor (today's pin behaviour)

Pins         →  ┌──────────────────────────────┐
                │ headline of the hovered story │
                │ Place · 2h ago · 12 sources   │
                └──────────────────────────────┘

Everything   →  12.3456°N, 56.7890°E · z8
                ┌──────────────────────────────┐
                │ headline of the hovered story │
                │ Place · 2h ago · 12 sources   │
                ├──────────────────────────────┤
                │ Af · Tropical rainforest      │
                │ 27.3 °C (81.1 °F)            │
                │ 4.2 m/s from NNE             │
                │ Clay · 32 %                  │
                │ D 3°12′E · I 61°44′↓         │
                └──────────────────────────────┘
```

## 4. Follow-ups (not in this change)

- Globe pin hover preview (the globe has click popups only).
- Native-styled tooltips for city mentions (replace `title=`).
- Basin name in the Everything card (needs a cheaper spatial index
  than the full ray-cast).
- Touch: long-press could open the HUD card; today taps open popups,
  which is the right behaviour on phones.
