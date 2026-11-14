/* ═══════════════════════════════════════════════════════════════════════
   view-handoff.js — carry the map state between the flat map and /globe.

   The two views are separate pages (Leaflet vs MapLibre) with their own
   storage keys and their own URL hashes. Until this file existed there
   was NO bridge: the globe button was a bare href="/globe", "Back to the
   map" was a bare href="/", and neither page read the other's
   localStorage. Switching views threw away the position, every overlay
   and every opacity — and nothing was shareable.

   THE PROBLEM THIS SOLVES: the two sides name overlays differently.

     flat map getLayerSlug() emits   temperature, magnetic,
       soil-soilgrids, cropland-esa, land-cover-esa, geology-macrostrat,
       wind-gfs, wind-speed-gfs, ocean-currents-live, earthquakes-usgs,
       tectonic-faults-usgs
     globe.js OVERLAYS[].key is       temp, mag, soil, cropland,
       landcover, geology, wind, wind-speed, ocean-current, earthquakes,
       faults

   ELEVEN of twenty-one would silently drop through `if (!st) continue`
   on the way in, because neither vocabulary is wrong — they just never
   agreed. The aliases live here, ONCE, and both pages translate through
   them. Six were found when the bridge was built; the other five
   (2026-11-07) had been dropping PORTED layers from real shared links —
   the owner's own link lost wind, wind speed and ocean currents in one
   hop — because the check that was supposed to catch this compared the
   globe key against itself. panel-parity.bun.test.js now computes each
   globe label's REAL flat slug out of app.js's getLayerSlug().

   The other direction inherits the same trap: `landcover` does not
   resolve on the flat map either (the layer is "🗺️ Land Cover (ESA)",
   whose slug is land-cover-esa, and "land cover" has a space in it), so
   resolveLayerName()'s substring fallback cannot reach it.

   Two hash shapes, both `#lat,lng,zoom/part=...`:
     flat   #12.3456,76.5432,9/time=24h/overlay=temperature@55
     globe  #12.3456,76.5432,9/overlay=temp@55/proj=globe
   Unknown parts are passed through untouched (the flat map carries
   pin/base/search/time/density, which the globe ignores).

   TWO MORE THINGS THIS FILE OWNS, because both are the same rule —
   "a round trip must not amputate the reader's own map":

     * `registerGlobeKeys()` lets globe.js declare what it can draw.
       Anything else in the incoming link is UNRENDERABLE there, cannot
       have been switched off (there is no checkbox for it), and is put
       back by `flatHref(globeHash, incomingHash)` — the back link, and
       only the back link. The globe's own URL stays honest and lists
       only what it is actually drawing.
     * The globe rewrites location.hash from the layers it drew, so the
       flat map's SETTINGS (density/wind/rivers/time/base/search/pin)
       are carried by globe.js's applyGlobeHash(). The globe cannot
       honour them; it must not delete them either.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // globe key -> flat-map slug. Both directions use THIS table, so the
  // two vocabularies can never drift apart without this file being wrong
  // in one obvious place (which the test asserts).
  var ALIASES = {
    temp: "temperature",
    mag: "magnetic",
    soil: "soil-soilgrids",
    cropland: "cropland-esa",
    landcover: "land-cover-esa",
    geology: "geology-macrostrat",
    // Five more whose two vocabularies NEVER agreed (2026-11-07). The
    // flat map's getLayerSlug() emits wind-gfs / wind-speed-gfs /
    // ocean-currents-live / earthquakes-usgs / tectonic-faults-usgs,
    // while the globe keys them wind / wind-speed / ocean-current /
    // earthquakes / faults — and every one of them is PORTED, so the
    // link lost a layer the globe could perfectly well draw. The owner's
    // own shared link lost three of them in one hop (wind, wind speed,
    // ocean currents). Caught by computing each globe label's REAL flat
    // slug from app.js's own getLayerSlug(), which is what
    // panel-parity.bun.test.js now does; the previous check compared the
    // globe key against itself and could never fail.
    wind: "wind-gfs",
    "wind-speed": "wind-speed-gfs",
    "ocean-current": "ocean-currents-live",
    earthquakes: "earthquakes-usgs",
    faults: "tectonic-faults-usgs",
    // Everything the two already share is deliberately ABSENT: a shared
    // slug maps to itself, and putting it in this table would hide a
    // future divergence instead of surfacing it.
  };

  var FLAT_TO_GLOBE = {};
  var GLOBE_TO_FLAT = {};
  Object.keys(ALIASES).forEach(function (globeKey) {
    var flat = ALIASES[globeKey];
    GLOBE_TO_FLAT[globeKey] = flat;
    FLAT_TO_GLOBE[flat] = globeKey;
  });

  function splitHash(hash) {
    var h = String(hash || "").replace(/^#/, "");
    if (!h) return { head: "", parts: [] };
    var parts = h.split("/");
    return { head: parts[0], parts: parts.slice(1) };
  }

  function rebuild(head, parts) {
    var out = parts.filter(function (p) { return p !== "" && p != null; });
    var all = out.slice();
    if (head) all.unshift(head);
    return all.length ? "#" + all.join("/") : "";
  }

  // Rewrite ONLY the overlay= part; everything else passes through.
  function mapOverlays(hash, translate) {
    var h = splitHash(hash);
    var found = false;
    var parts = h.parts.map(function (p) {
      if (p.indexOf("overlay=") !== 0) return p;
      found = true;
      var list = p.slice(8).split(",").filter(Boolean).map(function (entry) {
        var at = entry.lastIndexOf("@");
        var key = at > 0 ? entry.slice(0, at) : entry;
        var pct = at > 0 ? entry.slice(at) : "";   // keep "@pct" verbatim
        return translate(key) + pct;
      });
      return "overlay=" + list.join(",");
    });
    // A hash with overlays elsewhere than a leading overlay= is not
    // something either page writes; return it unchanged rather than
    // inventing a part.
    if (!found) return rebuild(h.head, parts);
    return rebuild(h.head, parts);
  }

  function toGlobeHash(flatHash) {
    return mapOverlays(flatHash, function (slug) {
      return FLAT_TO_GLOBE[slug] || slug;
    });
  }

  function toFlatHash(globeHash) {
    return mapOverlays(globeHash, function (key) {
      return GLOBE_TO_FLAT[key] || key;
    });
  }

  // The two links, built from live state. `proj=globe` marks the hash as
  // belonging to the globe so a copied URL reopens in the view it came
  // from — without it a shared 3D link would open flat and lose the
  // projection the sender chose.
  function globeHref(flatHash) {
    var h = toGlobeHash(flatHash);
    if (!h) return "/globe";
    var parts = h.replace(/^#/, "").split("/");
    var hasProj = parts.some(function (p) { return p.indexOf("proj=") === 0; });
    if (!hasProj) parts.push("proj=globe");
    return "/globe#" + parts.join("/");
  }

  // ── what the globe could not draw ────────────────────────────────────
  // globe.js registers its own overlay keys here. An overlay that is NOT
  // one of them cannot have been switched off on the globe — there is no
  // checkbox for it — so when a link arrives carrying overlays the globe
  // has no way to render, they must ride home in the "Back to the map"
  // link. Otherwise ONE visit to 3D amputates them from the reader's own
  // map: the globe rebuilds location.hash from the layers it drew, and
  // the back link is built from that.
  //
  // The globe's ADDRESS-BAR hash stays honest and lists only what it is
  // actually drawing. This carry lives in the back link alone.
  var GLOBE_KEYS = null;

  function registerGlobeKeys(keys) {
    GLOBE_KEYS = Object.prototype.toString.call(keys) === "[object Array]"
      ? keys.slice()
      : null;
  }

  function overlayEntriesOf(hash) {
    var parts = splitHash(hash).parts;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf("overlay=") === 0) {
        return parts[i].slice(8).split(",").filter(Boolean);
      }
    }
    return null;
  }

  // The entries of `incoming` the globe has no layer for. Keys are
  // compared AFTER translation through the alias table, so `wind-gfs` is
  // recognised as the globe's `wind` and left to the globe's own state
  // (which may legitimately have it off).
  function unrenderableOverlays(incomingHash) {
    if (!GLOBE_KEYS || !incomingHash) return [];
    var entries = overlayEntriesOf(incomingHash) || [];
    return entries.filter(function (entry) {
      var at = entry.lastIndexOf("@");
      var key = at > 0 ? entry.slice(0, at) : entry;
      return GLOBE_KEYS.indexOf(FLAT_TO_GLOBE[key] || key) < 0;
    });
  }

  function flatHref(globeHash, incomingHash) {
    var h = splitHash(toFlatHash(globeHash));
    // proj= is the globe's own token — carrying it to the flat map would
    // leave a part that page does not understand (it ignores it, but a
    // shared URL should not advertise a projection the page has none of).
    var parts = h.parts.filter(function (p) {
      return p.indexOf("proj=") !== 0;
    });
    // Put back what the globe was never able to show.
    var carry = unrenderableOverlays(incomingHash);
    if (carry.length) {
      var have = {};
      var idx = -1;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf("overlay=") !== 0) continue;
        idx = i;
        parts[i].slice(8).split(",").filter(Boolean).forEach(function (e) {
          var at = e.lastIndexOf("@");
          have[at > 0 ? e.slice(0, at) : e] = true;
        });
      }
      var add = carry.filter(function (e) {
        var at = e.lastIndexOf("@");
        return !have[at > 0 ? e.slice(0, at) : e];
      });
      if (add.length) {
        if (idx >= 0) {
          parts[idx] = parts[idx] + "," + add.join(",");
        } else {
          parts.push("overlay=" + add.join(","));
        }
      }
    }
    // rebuild() returns "#..." or "" — the flat map lives at the ROOT, so
    // the hash has to be prefixed with "/" or the link goes nowhere.
    var hash = rebuild(h.head, parts);
    return hash ? "/" + hash : "/";
  }

  window.XYZO_HANDOFF = {
    ALIASES: ALIASES,
    FLAT_TO_GLOBE: FLAT_TO_GLOBE,
    GLOBE_TO_FLAT: GLOBE_TO_FLAT,
    registerGlobeKeys: registerGlobeKeys,
    unrenderableOverlays: unrenderableOverlays,
    toGlobeHash: toGlobeHash,
    toFlatHash: toFlatHash,
    globeHref: globeHref,
    flatHref: flatHref,
  };
})();
