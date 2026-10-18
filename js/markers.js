const PIN_PATH = "M16 3c-5 0-9 4-9 9 0 6.8 9 16.2 9 16.2S25 18.8 25 12c0-5-4-9-9-9z";
// 全市が一画面に入るズームでは印を小さくする。件数はまとめない。
const LITE_ZOOM = 13;

function pinGraphic(approximate) {
  if (approximate) {
    return `<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="2.2 1.3" d="${PIN_PATH}"/><circle cx="16" cy="12" r="2.6" fill="currentColor"/>`;
  }
  return `<path fill="currentColor" d="${PIN_PATH}"/><circle cx="16" cy="12" r="2.4" fill="#fffaf2"/>`;
}

function pinMarkup(facility, { selected, dimmed, lite }) {
  const approximate = facility.address.location_precision === "approximate";
  const classes = ["pin", approximate ? "pin-approx" : "pin-exact"];
  if (selected) classes.push("is-active");
  if (dimmed) classes.push("is-dimmed");
  if (lite) classes.push("pin-lite");
  const label = dimmed
    ? `${facility.name}（絞り込み対象外）`
    : approximate
      ? `${facility.name}（町名までの位置）`
      : facility.name;
  return `<button type="button" class="${classes.join(" ")}" data-facility-id="${facility.id}" aria-pressed="${selected ? "true" : "false"}" aria-label="${escapeAttr(label)}">
    <svg viewBox="0 0 32 32" aria-hidden="true">${pinGraphic(approximate)}</svg>
  </button>`;
}

function pinIcon(html, lite) {
  const size = lite ? 28 : 44;
  const anchor = lite ? 26 : 40;
  return L.divIcon({
    className: "facility-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, anchor],
  });
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function syncMarkers(map, facilities, { selectedId, matchingIds, onToggle }) {
  const started = performance.now();
  if (!map._kodomoMarkers) map._kodomoMarkers = new Map();
  if (map._kodomoHalos) {
    for (const halo of map._kodomoHalos.values()) halo.remove();
    map._kodomoHalos = new Map();
  }
  const markers = map._kodomoMarkers;
  const liveIds = new Set(facilities.map((facility) => facility.id));
  const lite = map.getZoom() < LITE_ZOOM;

  for (const [id, marker] of markers) {
    if (!liveIds.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }

  for (const facility of facilities) {
    const selected = facility.id === selectedId;
    const dimmed = matchingIds && !matchingIds.has(facility.id);
    let marker = markers.get(facility.id);
    const html = pinMarkup(facility, { selected, dimmed, lite });
    if (!marker) {
      marker = L.marker([facility.lat, facility.lng], {
        icon: pinIcon(html, lite),
        keyboard: false,
        riseOnHover: !lite,
      });
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        onToggle(facility.id);
      });
      marker.addTo(map);
      markers.set(facility.id, marker);
    } else {
      marker.setLatLng([facility.lat, facility.lng]);
      marker.setIcon(pinIcon(html, lite));
    }
  }
  map._kodomoMarkerSyncMs = performance.now() - started;
}

export function markerButton(map, id) {
  const marker = map._kodomoMarkers?.get(id);
  return marker?.getElement()?.querySelector("button") || null;
}
