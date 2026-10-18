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
  // from touchstart, which is too late in Chromium. Enable it in the capture
  // phase, before Leaflet sees the second finger.
  const active = new Set();
  const container = map.getContainer();
  container.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    active.add(event.pointerId);
    if (active.size >= 2) map.dragging.enable();
    else map.dragging.disable();
  }, true);
  const release = (event) => {
    if (event.pointerType !== "touch") return;
    active.delete(event.pointerId);
    if (active.size < 2) map.dragging.disable();
  };
  container.addEventListener("pointerup", release, true);
  container.addEventListener("pointercancel", release, true);
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
