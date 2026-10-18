function pinMarkup(facility, { selected, dimmed }) {
  const approximate = facility.address.location_precision === "approximate";
  const classes = ["pin"];
  classes.push(approximate ? "pin-approx" : "pin-exact");
  if (selected) classes.push("is-active");
  if (dimmed) classes.push("is-dimmed");
  const label = dimmed
    ? `${facility.name}（絞り込み対象外）`
    : approximate
      ? `${facility.name}（町名までの位置）`
      : facility.name;
  return `<button type="button" class="${classes.join(" ")}" data-facility-id="${facility.id}" aria-pressed="${selected ? "true" : "false"}" aria-label="${escapeAttr(label)}">
    <svg viewBox="0 0 32 32" aria-hidden="true">
      ${
        approximate
          ? '<circle cx="16" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.5 2"/><circle cx="16" cy="16" r="3" fill="currentColor"/>'
          : '<path fill="currentColor" d="M16 3c-5 0-9 4-9 9 0 6.8 9 16.2 9 16.2S25 18.8 25 12c0-5-4-9-9-9zm0 12.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4z"/>'
      }
    </svg>
  </button>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function syncMarkers(map, facilities, { selectedId, matchingIds, onToggle, radiusMeters }) {
  if (!map._kodomoMarkers) {
    map._kodomoMarkers = new Map();
    map._kodomoHalos = new Map();
  }
  const markers = map._kodomoMarkers;
  const halos = map._kodomoHalos;
  const liveIds = new Set(facilities.map((facility) => facility.id));

  for (const [id, marker] of markers) {
    if (!liveIds.has(id)) {
      marker.remove();
      markers.delete(id);
      const halo = halos.get(id);
      if (halo) {
        halo.remove();
        halos.delete(id);
      }
    }
  }

  for (const facility of facilities) {
    const selected = facility.id === selectedId;
    const dimmed = matchingIds && !matchingIds.has(facility.id);
    let marker = markers.get(facility.id);
    const html = pinMarkup(facility, { selected, dimmed });
    if (!marker) {
      const icon = L.divIcon({
        className: "facility-marker",
        html,
        iconSize: [44, 44],
        iconAnchor: [22, 40],
      });
      marker = L.marker([facility.lat, facility.lng], {
        icon,
        keyboard: false,
        riseOnHover: true,
      });
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        onToggle(facility.id);
      });
      marker.addTo(map);
      markers.set(facility.id, marker);
    } else {
      marker.setIcon(
        L.divIcon({
          className: "facility-marker",
          html,
          iconSize: [44, 44],
          iconAnchor: [22, 40],
        })
      );
    }

    const approximate = facility.address.location_precision === "approximate";
    let halo = halos.get(facility.id);
    if (approximate) {
      if (!halo) {
        halo = L.circle([facility.lat, facility.lng], {
          radius: radiusMeters || 300,
          color: "#3d6b8c",
          weight: 1,
          fillColor: "#3d6b8c",
          fillOpacity: 0.12,
          interactive: false,
        });
        halo.addTo(map);
        halos.set(facility.id, halo);
      }
      halo.setStyle({ opacity: dimmed ? 0.25 : 0.9, fillOpacity: dimmed ? 0.04 : 0.12 });
    } else if (halo) {
      halo.remove();
      halos.delete(facility.id);
    }
  }
}

export function markerButton(map, id) {
  const marker = map._kodomoMarkers?.get(id);
  return marker?.getElement()?.querySelector("button") || null;
}
