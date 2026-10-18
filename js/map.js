export function createMap(container, config) {
  const fallback = config.fallbackCenter;
  const provider = config.tiles[config.tileProvider] || config.tiles.osm;
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    gestureHandling: true,
    gestureHandlingOptions: {
      text: config.gestureHandlingText,
      duration: 900,
    },
  });
  map.setView([fallback.lat, fallback.lng], config.initialZoom || 14);
  const tiles = L.tileLayer(provider.url, {
    attribution: provider.attribution,
    maxZoom: provider.maxZoom || 19,
  });
  tiles.addTo(map);
  map.attributionControl.setPrefix("");
  keepDragOnTwoFingers(map);
  return { map, tiles };
}

function keepDragOnTwoFingers(map) {
  // Leaflet starts a drag on pointerdown. GestureHandling turns dragging on
  // from touchstart, which is too late in Chromium, so the finger count has
  // to be right in the capture phase. pointerup does not always reach the map
  // (the finger leaves the element, or the browser takes the gesture), and a
  // stale id then leaves dragging stuck on or off.
  const active = new Set();
  const container = map.getContainer();

  const sync = () => {
    if (active.size >= 2) map.dragging.enable();
    else map.dragging.disable();
  };

  const forget = (pointerId) => {
    if (!active.delete(pointerId)) return;
    sync();
  };

  const releasePointer = (event) => {
    if (event.pointerType && event.pointerType !== "touch") return;
    if (event.pointerId == null) return;
    forget(event.pointerId);
  };

  container.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    // isPrimary means this touch is a new first finger. Ids still in the set
    // never received pointerup or pointercancel.
    if (event.isPrimary) active.clear();
    else if (active.has(event.pointerId)) active.delete(event.pointerId);
    active.add(event.pointerId);
    sync();
  }, true);

  container.addEventListener("pointerleave", releasePointer);
  container.addEventListener("lostpointercapture", releasePointer);
  window.addEventListener("pointerup", releasePointer, true);
  window.addEventListener("pointercancel", releasePointer, true);
  window.addEventListener("blur", () => {
    if (active.size === 0) return;
    active.clear();
    sync();
  });

  const releaseIfIdle = (event) => {
    if (event.touches && event.touches.length === 0 && active.size > 0) {
      active.clear();
      sync();
    }
  };
  container.addEventListener("touchend", releaseIfIdle, true);
  container.addEventListener("touchcancel", releaseIfIdle, true);
}

export function setTileProvider(map, tiles, config, providerId) {
  const provider = config.tiles[providerId];
  if (!provider) return tiles;
  map.removeLayer(tiles);
  const next = L.tileLayer(provider.url, {
    attribution: provider.attribution,
    maxZoom: provider.maxZoom || 19,
  });
  next.addTo(map);
  return next;
}
