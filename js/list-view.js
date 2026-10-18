import { formatDistance } from "./geo.js";
import { formatTargets, formatWeekdays } from "./filters.js";

export function renderList(container, items, { originKind, originLabel, onSelect }) {
  const originNote =
    originKind === "gps"
      ? "現在地からの直線距離です。"
      : originKind === "fallback"
        ? `現在地が取得できないため、${originLabel}からの直線距離です。`
        : "距離の基準地点を決めています。";

  if (!items.length) {
    container.innerHTML = `<p class="list-note">${escapeHtml(originNote)}</p>
      <p class="empty">条件に合う子ども食堂はありません。絞り込みを外すと再表示されます。</p>`;
    return;
  }

  const cards = items
    .map((item) => {
      const facility = item.facility;
      const badges = [
        facility.address.location_precision === "approximate"
          ? `<span class="badge badge-approx">町名までの位置</span>`
          : "",
      ].join("");
      return `<li>
        <button type="button" class="card" data-facility-id="${escapeAttr(facility.id)}">
          <span class="card-top">
            <span class="card-name">${escapeHtml(facility.name)}</span>
            ${badges}
          </span>
          <span class="card-distance">${escapeHtml(formatDistance(item.distanceMeters))}</span>
          <span class="card-meta">${escapeHtml(formatWeekdays(facility.schedule.weekdays))} ${escapeHtml(facility.schedule.time_text || "")}</span>
          <span class="card-meta">対象: ${escapeHtml(formatTargets(facility.target))}</span>
          <span class="card-address">${escapeHtml(formatAddress(facility))}</span>
        </button>
      </li>`;
    })
    .join("");

  container.innerHTML = `<p class="list-note">${escapeHtml(originNote)} ${items.length}件、近い順。</p><ul class="cards">${cards}</ul>`;
  container.querySelectorAll(".card").forEach((button) => {
    button.addEventListener("click", () => onSelect(button.dataset.facilityId));
  });
}

function formatAddress(facility) {
  const address = facility.address;
  return `${address.prefecture}${address.city}${address.detail}`;
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
