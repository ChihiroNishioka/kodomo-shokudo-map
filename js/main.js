import { loadAppConfig, loadJson } from "./config.js";
import { createMap } from "./map.js";
import { syncMarkers, markerButton } from "./markers.js";
import { renderList } from "./list-view.js";
import { WEEKDAYS, TARGETS, matchesFacility, formatTargets, formatWeekdays } from "./filters.js";
import { formatDistance, haversineMeters } from "./geo.js";

const state = {
  facilities: [],
  sources: null,
  origin: null,
  originKind: "pending",
  selectedId: null,
  view: "map",
  filters: { weekdays: new Set(), targets: new Set() },
  map: null,
  config: null,
  lastFocus: null,
};

const els = {};

async function main() {
  cacheElements();
  bindStaticUi();
  try {
    const { config, dataUrl, sourcesUrl } = await loadAppConfig();
    state.config = config;
    const { map } = createMap(els.map, config);
    state.map = map;
    map.on("click", () => {
      if (state.selectedId) closeDetail(true);
    });
    map.on("zoomend", () => {
      if (state.facilities.length) syncMarkers(map, state.facilities, markerOptions());
    });
    const [facilities, sources] = await Promise.all([
      loadJson(dataUrl),
      sourcesUrl ? loadJson(sourcesUrl).catch(() => null) : Promise.resolve(null),
    ]);
    state.facilities = facilities;
    state.sources = sources;
    renderSourceDialog();
    renderFilterForm();
    syncMarkers(map, facilities, markerOptions());
    locate();
    window.__kodomoMap = {
      map,
      get ready() {
        return state.originKind === "gps" || state.originKind === "fallback";
      },
      get facilities() {
        return state.facilities;
      },
      get originKind() {
        return state.originKind;
      },
      get selectedId() {
        return state.selectedId;
      },
      get lastMarkerSyncMs() {
        return state.map?._kodomoMarkerSyncMs ?? null;
      },
    };
  } catch (error) {
    showFatal(error.message || "読み込みに失敗しました");
  }
}

function cacheElements() {
  for (const id of [
    "map",
    "geo-banner",
    "geo-message",
    "geo-retry",
    "geo-nearest",
    "locate-btn",
    "zoom-in",
    "zoom-out",
    "tab-map",
    "tab-list",
    "filter-button",
    "filter-panel",
    "filter-form",
    "filter-clear",
    "filter-close",
    "detail",
    "detail-close",
    "detail-body",
    "list-view",
    "map-view",
    "source-button",
    "source-panel",
    "source-close",
    "source-body",
    "fatal",
    "info-toggle",
    "info-panel",
  ]) {
    els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }
}

function bindStaticUi() {
  els.zoomIn.addEventListener("click", () => state.map?.zoomIn());
  els.zoomOut.addEventListener("click", () => state.map?.zoomOut());
  els.locateBtn.addEventListener("click", () => locate());
  els.geoRetry.addEventListener("click", () => locate());
  els.geoNearest.addEventListener("click", () => moveToNearest());
  els.tabMap.addEventListener("click", () => setView("map"));
  els.tabList.addEventListener("click", () => setView("list"));
  els.filterButton.addEventListener("click", () => toggleFilter(true));
  els.filterClose.addEventListener("click", () => toggleFilter(false));
  els.filterClear.addEventListener("click", () => clearFilters());
  els.detailClose.addEventListener("click", () => closeDetail(true));
  els.sourceButton.addEventListener("click", () => toggleSource(true));
  els.sourceClose.addEventListener("click", () => toggleSource(false));
  els.infoToggle.addEventListener("click", () => toggleInfo(els.infoPanel.hidden));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.detail.hidden) closeDetail(true);
    else if (!els.filterPanel.hidden) toggleFilter(false);
    else if (!els.sourcePanel.hidden) toggleSource(false);
    else if (!els.infoPanel.hidden) {
      toggleInfo(false);
      els.infoToggle.focus();
    }
  });
}

function toggleInfo(open) {
  els.infoPanel.hidden = !open;
  els.infoToggle.setAttribute("aria-expanded", String(open));
  els.infoToggle.setAttribute("aria-label", open ? "説明を閉じる" : "説明を開く");
  const mark = els.infoToggle.querySelector(".info-toggle-mark");
  if (mark) mark.textContent = open ? "▲" : "▼";
  state.map?.invalidateSize({ animate: false });
}

function markerOptions() {
  return {
    selectedId: state.selectedId,
    matchingIds: matchingIdSet(),
    onToggle: toggleFacility,
  };
}

function matchingIdSet() {
  const ids = new Set();
  for (const facility of state.facilities) {
    if (matchesFacility(facility, state.filters)) ids.add(facility.id);
  }
  return ids;
}

function locate() {
  state.originKind = "pending";
  setGeoBanner("現在地を取得しています。");
  if (!navigator.geolocation) {
    applyFallback("このブラウザは位置情報に対応していません。");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const origin = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      state.origin = origin;
      state.originKind = "gps";
      els.geoBanner.hidden = true;
      showUserMarker(origin, position.coords.accuracy);
      state.map.setView([origin.lat, origin.lng], state.config.initialZoom || 15);
      refreshViews();
      showNeighborhoodHint(origin);
    },
    () => {
      applyFallback("現在地が取得できません。");
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

function applyFallback(message) {
  const fallback = state.config.fallbackCenter;
  state.origin = { lat: fallback.lat, lng: fallback.lng };
  state.originKind = "fallback";
  clearUserMarker();
  state.map.setView([fallback.lat, fallback.lng], Math.min(state.config.initialZoom || 14, 14));
  setGeoBanner(`${message}中心は${fallback.label}です。`, { retry: true });
  refreshViews();
}

function setGeoBanner(message, { retry = false, nearest = false, tone = "error" } = {}) {
  els.geoMessage.textContent = message;
  els.geoRetry.hidden = !retry;
  els.geoNearest.hidden = !nearest;
  els.geoBanner.classList.toggle("is-error", tone === "error");
  els.geoBanner.classList.toggle("is-info", tone === "info");
  els.geoBanner.hidden = false;
}

function nearestFacility(origin) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const facility of state.facilities) {
    const distanceMeters = haversineMeters(origin, facility);
    if (distanceMeters < bestDistance) {
      best = facility;
      bestDistance = distanceMeters;
    }
  }
  return best ? { facility: best, distanceMeters: bestDistance } : null;
}

function pinsInView() {
  const bounds = state.map.getBounds();
  return state.facilities.some((facility) => bounds.contains([facility.lat, facility.lng]));
}

function showNeighborhoodHint(origin) {
  if (pinsInView()) {
    els.geoNearest.hidden = true;
    return;
  }
  const nearest = nearestFacility(origin);
  if (!nearest) return;
  state.nearestId = nearest.facility.id;
  const distance = formatDistance(nearest.distanceMeters);
  setGeoBanner(
    `近くに子ども食堂がありません。「${nearest.facility.name}」まで${distance}。`,
    { nearest: true, tone: "info" }
  );
}

function moveToNearest() {
  const nearest = state.origin ? nearestFacility(state.origin) : null;
  if (!nearest) return;
  state.nearestId = nearest.facility.id;
  state.map.setView([nearest.facility.lat, nearest.facility.lng], state.config.initialZoom || 15);
  els.geoBanner.hidden = true;
}

function showUserMarker(origin, accuracy) {
  clearUserMarker();
  const icon = L.divIcon({
    className: "user-marker",
    html: '<span class="user-dot" aria-label="現在地"></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  state.userMarker = L.marker([origin.lat, origin.lng], {
    icon,
    interactive: false,
    keyboard: false,
    zIndexOffset: 500,
  }).addTo(state.map);
  if (accuracy && accuracy < 1500) {
    state.userHalo = L.circle([origin.lat, origin.lng], {
      radius: accuracy,
      color: "#1d6fbf",
      weight: 1,
      fillColor: "#1d6fbf",
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(state.map);
  }
}

function clearUserMarker() {
  state.userMarker?.remove();
  state.userHalo?.remove();
  state.userMarker = null;
  state.userHalo = null;
}

function refreshViews() {
  syncMarkers(state.map, state.facilities, markerOptions());
  renderListView();
  updateFilterCount();
  if (state.selectedId) fillDetail(state.selectedId);
}

function sortedFacilities() {
  const origin = state.origin;
  const matched = state.facilities.filter((facility) => matchesFacility(facility, state.filters));
  const items = matched.map((facility) => ({
    facility,
    distanceMeters: origin ? haversineMeters(origin, facility) : Number.POSITIVE_INFINITY,
  }));
  items.sort((a, b) => a.distanceMeters - b.distanceMeters || a.facility.name.localeCompare(b.facility.name, "ja"));
  return items;
}

function renderListView() {
  renderList(els.listView, sortedFacilities(), {
    originKind: state.originKind,
    originLabel: state.config.fallbackCenter.label,
    onSelect: (id) => {
      setView("map");
      const facility = state.facilities.find((item) => item.id === id);
      if (facility) state.map.setView([facility.lat, facility.lng], Math.max(state.map.getZoom(), 15));
      selectFacility(id, true);
    },
  });
}

function toggleFacility(id) {
  if (state.selectedId === id) closeDetail(true);
  else selectFacility(id, true);
}

function selectFacility(id, restoreFocus) {
  closeOtherSheets("detail");
  state.lastFocus = markerButton(state.map, id) || document.activeElement;
  state.selectedId = id;
  syncMarkers(state.map, state.facilities, markerOptions());
  fillDetail(id);
  els.detail.hidden = false;
  revealPin(id);
  if (restoreFocus) els.detailClose.focus();
}

function revealPin(id) {
  const facility = state.facilities.find((item) => item.id === id);
  if (!facility) return;
  const mapEl = state.map.getContainer();
  const mapRect = mapEl.getBoundingClientRect();
  const sheetTop = els.detail.getBoundingClientRect().top;
  const bannerHeight = els.geoBanner.hidden ? 0 : els.geoBanner.getBoundingClientRect().height + 8;
  const visibleBottom = Math.min(mapRect.bottom, sheetTop) - 20;
  const visibleTop = mapRect.top + 16 + bannerHeight;
  if (visibleBottom - visibleTop < 64) return;
  const point = state.map.latLngToContainerPoint([facility.lat, facility.lng]);
  const targetY = (visibleTop + visibleBottom) / 2 - mapRect.top;
  state.map.panBy([point.x - mapRect.width / 2, point.y - targetY], { animate: false });
}

function closeOtherSheets(except) {
  if (except !== "detail" && !els.detail.hidden) closeDetail(false);
  if (except !== "filter" && !els.filterPanel.hidden) {
    els.filterPanel.hidden = true;
    els.filterButton.setAttribute("aria-expanded", "false");
  }
  if (except !== "source" && !els.sourcePanel.hidden) {
    els.sourcePanel.hidden = true;
    els.sourceButton.setAttribute("aria-expanded", "false");
  }
}

function closeDetail(restoreFocus) {
  const previous = state.selectedId;
  state.selectedId = null;
  els.detail.hidden = true;
  syncMarkers(state.map, state.facilities, markerOptions());
  if (restoreFocus && previous) {
    const button = markerButton(state.map, previous) || state.lastFocus;
    button?.focus?.();
  }
}

function fillDetail(id) {
  const facility = state.facilities.find((item) => item.id === id);
  if (!facility) return;
  const address = facility.address;
  const approximate = address.location_precision === "approximate";
  const phone = facility.contact.phone && facility.contact.phone !== "未確認"
    ? escapeHtml(facility.contact.phone)
    : "未確認";
  const url = externalAnchor(facility.contact.url, "施設・団体のページ") || "未確認";
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${facility.lat},${facility.lng}`;
  const counts = precisionSummary();
  els.detailBody.innerHTML = `
    <p class="badges">
      ${facility.is_sample ? '<span class="badge badge-sample">架空のサンプル</span>' : ""}
      ${approximate ? '<span class="badge badge-approx">町名までの位置</span>' : ""}
      ${licenseBadge(facility.source)}
    </p>
    <h2 id="detail-title">${escapeHtml(facility.name)}</h2>
    ${facility.description ? `<p class="detail-lead">${escapeHtml(facility.description)}</p>` : ""}
    <dl class="facts">
      <div><dt>開催</dt><dd>${escapeHtml(facility.schedule.frequency_text)}</dd></div>
      <div><dt>曜日</dt><dd>${escapeHtml(formatWeekdays(facility.schedule.weekdays))}</dd></div>
      <div><dt>時間</dt><dd>${escapeHtml(facility.schedule.time_text || "記載なし")}</dd></div>
      <div><dt>対象</dt><dd>${escapeHtml(formatTargets(facility.target))}</dd></div>
      <div><dt>住所</dt><dd>${escapeHtml(address.prefecture + address.city + address.detail)}</dd></div>
      <div><dt>料金</dt><dd>${escapeHtml(facility.fee_text || "記載なし")}</dd></div>
      <div><dt>電話</dt><dd>${phone}</dd></div>
      <div><dt>ウェブ</dt><dd>${url}</dd></div>
      <div><dt>出典</dt><dd>${externalAnchor(facility.source.dataset_url, facility.source.provider) || escapeHtml(facility.source.provider)}
        / ${externalAnchor(facility.source.license_url, facility.source.license) || escapeHtml(facility.source.license)}
        <span class="fresh">取得日 ${escapeHtml(facility.source.retrieved)}</span></dd></div>
    </dl>
    ${approximate ? `<p class="detail-note">番地の号や枝番まで一致しなかったため、町名までの位置を示しています。掲載${counts.total}件のうち、番地まで一致は${counts.block}件、そこまで取れなかった概位は${counts.town}件です。個人宅を隠すための位置ずらしではありません。</p>` : ""}
    <p class="detail-warning">${escapeHtml(facility.schedule.notes)}</p>
    <a class="directions" id="detail-directions" href="${escapeAttr(directions)}" target="_blank" rel="noopener noreferrer">経路を見る</a>
  `;
}

function setView(view) {
  state.view = view;
  els.mapView.hidden = view !== "map";
  els.listView.hidden = view !== "list";
  els.tabMap.setAttribute("aria-selected", String(view === "map"));
  els.tabList.setAttribute("aria-selected", String(view === "list"));
  if (view === "map") {
    requestAnimationFrame(() => state.map.invalidateSize());
  } else {
    renderListView();
  }
}

function renderFilterForm() {
  const days = WEEKDAYS.map(
    ([code, label]) =>
      `<label class="check"><input type="checkbox" name="weekday" value="${code}"> ${label}</label>`
  ).join("");
  const targets = TARGETS.map(
    ([code, label]) =>
      `<label class="check"><input type="checkbox" name="target" value="${code}"> ${label}</label>`
  ).join("");
  els.filterForm.innerHTML = `
    <fieldset>
      <legend>開催曜日</legend>
      <div class="checks">${days}</div>
    </fieldset>
    <fieldset>
      <legend>対象</legend>
      <div class="checks">${targets}</div>
    </fieldset>
    <p class="filter-help">選んでいない項目は、すべて表示します。曜日の記載がない食堂は、曜日を選ぶと一覧から外れ、地図では薄いピンになります。</p>
  `;
  els.filterForm.addEventListener("change", () => {
    state.filters.weekdays = new Set(
      [...els.filterForm.querySelectorAll('input[name="weekday"]:checked')].map((input) => input.value)
    );
    state.filters.targets = new Set(
      [...els.filterForm.querySelectorAll('input[name="target"]:checked')].map((input) => input.value)
    );
    refreshViews();
  });
}

function clearFilters() {
  els.filterForm.querySelectorAll("input").forEach((input) => {
    input.checked = false;
  });
  state.filters.weekdays.clear();
  state.filters.targets.clear();
  refreshViews();
}

function updateFilterCount() {
  const count = state.filters.weekdays.size + state.filters.targets.size;
  els.filterButton.textContent = count ? `絞り込み ${count}` : "絞り込み";
  els.filterButton.setAttribute("aria-expanded", String(!els.filterPanel.hidden));
}

function toggleFilter(open) {
  if (open) closeOtherSheets("filter");
  els.filterPanel.hidden = !open;
  els.filterButton.setAttribute("aria-expanded", String(open));
  if (open) els.filterClose.focus();
  else els.filterButton.focus();
}

function renderSourceDialog() {
  const summary = state.sources;
  const included = summary?.sources || [];
  const missing = summary?.not_included || [];
  const counts = precisionSummary();
  const rows = included
    .map(
      (source) => `<li>${externalAnchor(source.dataset_url, source.provider) || escapeHtml(source.provider)}
        <span>${externalAnchor(source.license_url, source.license) || escapeHtml(source.license)} / 掲載 ${source.published_rows}件（元データ ${source.input_rows}件）</span></li>`
    )
    .join("");
  const gaps = missing
    .map((item) => `<li><strong>${escapeHtml(item.area)}</strong> ${escapeHtml(item.reason)}</li>`)
    .join("");
  els.sourceBody.innerHTML = `
    <p>掲載 ${summary?.published_count ?? state.facilities.length}件。地図に無い区は、二次利用できるオープンデータがカタログに無かったため入れていません。高津区の追加分は、出所を明示すれば転載できる公開情報と、許諾文が見当たらない一覧の事実情報です。</p>
    <h3>使ったデータ</h3>
    <ul class="source-list">${rows}</ul>
    <h3>入れてないもの</h3>
    <ul class="source-list">${gaps}</ul>
    <p>座標が元データに無い会場は、国土地理院の住所検索で調べ、番地が号で止まっていたものは住居表示の基礎番号も照合しています。住所検索の点から250mより遠い結果は採用していません。番地まで一致したのは${counts.block}件、町名までの概位は${counts.town}件です。「町名までの位置」は、号や枝番まで一致しなかった会場と、番地の無い丁目だけの会場です。</p>
  `;
}

function toggleSource(open) {
  if (open) closeOtherSheets("source");
  els.sourcePanel.hidden = !open;
  els.sourceButton.setAttribute("aria-expanded", String(open));
  if (open) els.sourceClose.focus();
  else els.sourceButton.focus();
}

function showFatal(message) {
  els.fatal.hidden = false;
  els.fatal.textContent = message;
}

function precisionSummary() {
  const total = state.facilities.length;
  const town = state.facilities.filter((facility) => facility.address.location_precision === "approximate").length;
  return { total, town, block: total - town };
}

function safeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /\s/.test(raw)) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";
  return parsed.href;
}

function externalAnchor(url, label) {
  const href = safeHttpUrl(url);
  if (!href) return "";
  return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function licenseBadge(source) {
  const text = escapeHtml(source.license);
  const href = safeHttpUrl(source.license_url);
  if (!href) return `<span class="badge">${text}</span>`;
  return `<a class="badge" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

main();
