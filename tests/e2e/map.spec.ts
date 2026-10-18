import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

type Facility = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  is_sample: boolean;
  address?: { location_precision?: string };
  contact: { phone: string; url: string };
  source: { license: string; license_url?: string; dataset_url?: string; provider?: string };
};

const facilities = JSON.parse(fs.readFileSync("data/facilities.json", "utf8")) as Facility[];
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8")) as {
  fallbackCenter: { lat: number; lng: number; label: string };
};

const spot = pickDenseFacility(facilities);
const userLocation = {
  latitude: spot.lat + 0.0011,
  longitude: spot.lng + 0.0011,
};

const screenshotDir = "test-results/screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

test.beforeEach(async ({ page }) => {
  if (process.env.MOCK_TILES === "0") return;
  await page.route(/tile\.openstreetmap\.org|cyberjapandata\.gsi\.go\.jp/, (route) =>
    route.fulfill({ path: "tests/fixtures/tile.png", contentType: "image/png" })
  );
});

test.describe("現在地が取れる", () => {
  test.use({
    geolocation: userLocation,
    permissions: ["geolocation"],
  });

  test("初期表示、ピンのトグル、ズーム、フィルタ、経路", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    const center = await mapCenter(page);
    expect(Math.abs(center.lat - userLocation.latitude)).toBeLessThan(0.002);
    expect(Math.abs(center.lng - userLocation.longitude)).toBeLessThan(0.002);
    await expect(page.locator("#map")).toHaveAttribute("role", "region");
    await expect(page.locator("#map")).not.toHaveAttribute("role", "application");
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    const layout = await page.evaluate(() => {
      const map = document.querySelector("#map")!.getBoundingClientRect();
      const zoom = document.querySelector(".zoom")!.getBoundingClientRect();
      const attr = document.querySelector(".leaflet-control-attribution")!.getBoundingClientRect();
      const locate = document.querySelector("#locate-btn")!.getBoundingClientRect();
      const overlaps = (a: DOMRect, b: DOMRect) =>
        a.width > 0 &&
        b.width > 0 &&
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top;
      return {
        zoomAttr: overlaps(zoom, attr),
        locateAttr: overlaps(locate, attr),
        attrInside:
          attr.top >= map.top - 1 &&
          attr.bottom <= map.bottom + 1 &&
          attr.left >= map.left - 1 &&
          attr.right <= map.right + 1,
        attrText: document.querySelector(".leaflet-control-attribution")?.textContent || "",
      };
    });
    expect(layout.zoomAttr).toBe(false);
    expect(layout.locateAttr).toBe(false);
    expect(layout.attrInside).toBe(true);
    expect(layout.attrText).toContain("OpenStreetMap");
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    await expect(page.locator("#notice-text")).toHaveText("開催日は変更の可能性あり");
    await expect(page.locator("#notice-text")).toBeVisible();
    await expect(page.locator("#info-panel")).toBeHidden();
    await expect(page.locator("#info-toggle")).toHaveAttribute("aria-expanded", "false");
    const initialArea = await recordMapArea(page, "initial");
    expect(initialArea.topBarHeight).toBeLessThanOrEqual(44);
    expect(initialArea.headerHeight).toBeLessThanOrEqual(initialArea.topBarHeight + 1);
    expect(initialArea.noticeFits).toBe(true);
    expect(initialArea.ratio).toBeGreaterThanOrEqual(0.7);
    await expect(page.locator("#geo-banner")).toBeHidden();
    await expect(page.locator("#detail")).toBeHidden();
    await expect(page.locator(".pin")).toHaveCount(facilities.length);

    const loaded = await page.evaluate(() => window.__kodomoMap.facilities);
    expect(loaded.length).toBeGreaterThan(100);
    expect(loaded.every((facility: Facility) => facility.is_sample === false)).toBe(true);
    const serialized = JSON.stringify(loaded);
    expect(serialized).not.toContain("様方");
    expect(serialized).not.toContain("様宅");
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/(?<!\d)0[789]0-?\d{4}-?\d{4}(?!\d)/);
    expect(serialized).not.toMatch(/\d{2,4}号室/);

    await page.screenshot({ path: `${screenshotDir}/01_initial.png`, fullPage: false });

    await page.locator("#info-toggle").click();
    await expect(page.locator("#info-panel")).toBeVisible();
    await expect(page.locator("#info-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#notice-full")).toContainText(
      "開催日・開催時間は変更される場合があります。訪問前に必ず施設・自治体にご確認ください"
    );
    await expect(page.locator(".notice-more")).toContainText("掲載データの注意");
    await expect(page.locator(".notice-more")).not.toHaveAttribute("open");
    await expect(page.locator(".legend")).toContainText("赤ピンは、番地まで分かっている子ども食堂");
    await expect(page.locator(".legend")).toContainText("青丸は、町名までの位置");
    await expect(page.locator(".legend")).toContainText("クラスターではありません");
    await page.screenshot({ path: `${screenshotDir}/07_info_expanded.png`, fullPage: false });
    await page.locator("#info-toggle").click();
    await expect(page.locator("#info-panel")).toBeHidden();

    const zoomBefore = await page.evaluate(() => window.__kodomoMap.map.getZoom());
    await page.getByRole("button", { name: "ズームイン" }).click();
    await expect.poll(async () => page.evaluate(() => window.__kodomoMap.map.getZoom())).toBe(zoomBefore + 1);
    await page.screenshot({ path: `${screenshotDir}/02_before_pin_tap.png`, fullPage: false });

    const pin = page.locator(`.pin[data-facility-id="${spot.id}"]`);
    await pin.tap();
    await expect(page.locator("#detail")).toBeVisible();
    await expect(page.locator("#detail-title")).toHaveText(spot.name);
    await expect(page.locator("#detail-directions")).toHaveAttribute(
      "href",
      new RegExp(`destination=${spot.lat},${spot.lng}`)
    );
    await expect(page.locator("#detail")).toContainText(spot.source?.license || "CC BY");
    await page.screenshot({ path: `${screenshotDir}/03_after_pin_tap.png`, fullPage: false });

    await pin.tap();
    await expect(page.locator("#detail")).toBeHidden();
    await page.screenshot({ path: `${screenshotDir}/05_pin_deselected.png`, fullPage: false });

    await page.getByRole("button", { name: "絞り込み" }).click();
    await page.locator('input[name="weekday"][value="sat"]').check();
    await page.getByRole("button", { name: "絞り込みを閉じる" }).click();
    const saturday = facilities.filter((facility) =>
      (facility as Facility & { schedule?: { weekdays?: string[] } }).schedule?.weekdays?.includes("sat")
    );
    await page.getByRole("tab", { name: "一覧" }).click();
    await expect(page.locator(".card")).toHaveCount(saturday.length);
    await expect(page.locator(".list-note")).toContainText("現在地からの直線距離");
    const firstDistance = await page.locator(".card-distance").first().innerText();
    const distances = await page.locator(".card-distance").allInnerTexts();
    expect(distances[0]).toBe(firstDistance);
    const meters = distances.map(parseDistance);
    expect(meters).toEqual([...meters].sort((a, b) => a - b));

    await page.getByRole("tab", { name: "地図" }).click();
    await expect(page.locator(".pin.is-dimmed")).toHaveCount(facilities.length - saturday.length);
  });

  test("一本指では地図が動かず、二本指でパンできる", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    const box = await page.locator("#map").boundingBox();
    if (!box) throw new Error("map box missing");
    const before = await mapCenter(page);
    await drag(page, [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }], [
      { x: box.x + box.width / 2 - 80, y: box.y + box.height / 2 },
    ]);
    const afterOne = await mapCenter(page);
    expect(Math.abs(afterOne.lat - before.lat)).toBeLessThan(0.00001);
    expect(Math.abs(afterOne.lng - before.lng)).toBeLessThan(0.00001);
    expect(await page.evaluate(() => window.__kodomoMap.map.dragging.enabled())).toBe(false);

    const startA = { x: box.x + box.width / 2 - 30, y: box.y + box.height / 2 };
    const startB = { x: box.x + box.width / 2 + 30, y: box.y + box.height / 2 };
    await drag(page, [startA, startB], [startA, startB]);
    await drag(
      page,
      [startA, startB],
      [
        { x: startA.x - 70, y: startA.y },
        { x: startB.x - 70, y: startB.y },
      ]
    );
    const afterTwo = await mapCenter(page);
    const moved =
      Math.abs(afterTwo.lat - afterOne.lat) > 0.00005 ||
      Math.abs(afterTwo.lng - afterOne.lng) > 0.00005;
    expect(moved).toBe(true);
    expect(await draggingEnabled(page)).toBe(false);

    await drag(page, [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }], [
      { x: box.x + box.width / 2 - 80, y: box.y + box.height / 2 },
    ]);
    const afterRelease = await mapCenter(page);
    expect(Math.abs(afterRelease.lat - afterTwo.lat)).toBeLessThan(0.00001);
    expect(Math.abs(afterRelease.lng - afterTwo.lng)).toBeLessThan(0.00001);
    expect(await draggingEnabled(page)).toBe(false);
  });

  test("地図の外で離した指が残り、一本指で動かない", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });

    await touchPointer(page, "pointerdown", "map", 1, true);
    await touchPointer(page, "pointerdown", "map", 2, false);
    expect(await draggingEnabled(page)).toBe(true);

    await touchPointer(page, "pointerup", "documentElement", 1, false);
    await touchPointer(page, "pointerup", "documentElement", 2, false);
    expect(await draggingEnabled(page)).toBe(false);

    const box = await page.locator("#map").boundingBox();
    if (!box) throw new Error("map box missing");
    const before = await mapCenter(page);
    await drag(page, [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }], [
      { x: box.x + box.width / 2 - 90, y: box.y + box.height / 2 },
    ]);
    const afterOne = await mapCenter(page);
    expect(Math.abs(afterOne.lat - before.lat)).toBeLessThan(0.00001);
    expect(Math.abs(afterOne.lng - before.lng)).toBeLessThan(0.00001);

    const startA = { x: box.x + box.width / 2 - 30, y: box.y + box.height / 2 };
    const startB = { x: box.x + box.width / 2 + 30, y: box.y + box.height / 2 };
    await drag(page, [startA, startB], [
      { x: startA.x - 70, y: startA.y },
      { x: startB.x - 70, y: startB.y },
    ]);
    const afterTwo = await mapCenter(page);
    const moved =
      Math.abs(afterTwo.lat - afterOne.lat) > 0.00005 ||
      Math.abs(afterTwo.lng - afterOne.lng) > 0.00005;
    expect(moved).toBe(true);
    expect(await draggingEnabled(page)).toBe(false);
  });

  test("pointerup が無くても次の主ポインタと pointerleave で本数を捨てる", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);

    await touchPointer(page, "pointerdown", "map", 7, true);
    await touchPointer(page, "pointerdown", "map", 8, false);
    expect(await draggingEnabled(page)).toBe(true);
    await touchPointer(page, "pointerleave", "map", 7, false);
    await touchPointer(page, "pointerleave", "map", 8, false);
    expect(await draggingEnabled(page)).toBe(false);

    await touchPointer(page, "pointerdown", "map", 9, true);
    await touchPointer(page, "pointerdown", "map", 10, false);
    expect(await draggingEnabled(page)).toBe(true);
    await touchPointer(page, "pointerdown", "map", 11, true);
    expect(await draggingEnabled(page)).toBe(false);

    await touchPointer(page, "pointerdown", "map", 12, true);
    await touchPointer(page, "pointerdown", "map", 13, false);
    expect(await draggingEnabled(page)).toBe(true);
    await page.evaluate(() => {
      const map = document.querySelector("#map");
      const event = new Event("touchend", { bubbles: true });
      Object.defineProperty(event, "touches", { value: [] });
      map?.dispatchEvent(event);
    });
    expect(await draggingEnabled(page)).toBe(false);
    await touchPointer(page, "pointercancel", "documentElement", 12, false);
    await touchPointer(page, "pointercancel", "documentElement", 13, false);
    expect(await draggingEnabled(page)).toBe(false);
  });
});

test.describe("現在地が取れない", () => {
  test.use({ permissions: [] });

  test("フォールバック中心と再試行", async ({ page, context }) => {
    await page.goto("/");
    await waitForMap(page);
    await expect(page.locator("#geo-banner")).toContainText("現在地が取得できません");
    await expect(page.locator("#geo-banner")).toContainText(config.fallbackCenter.label);
    await expect(page.locator("#geo-retry")).toBeVisible();
    const fallbackArea = await recordMapArea(page, "geolocation-fallback");
    expect(fallbackArea.ratio).toBeGreaterThanOrEqual(0.7);
    expect(await overlaps(page, "#geo-banner", ".zoom")).toBe(false);
    expect(await overlaps(page, "#geo-banner", ".leaflet-control-attribution")).toBe(false);
    const center = await mapCenter(page);
    expect(Math.abs(center.lat - config.fallbackCenter.lat)).toBeLessThan(0.002);
    expect(Math.abs(center.lng - config.fallbackCenter.lng)).toBeLessThan(0.002);
    await expect(page.locator("#list-view")).toBeHidden();
    await page.getByRole("tab", { name: "一覧" }).click();
    await expect(page.locator(".list-note")).toContainText(config.fallbackCenter.label);
    await page.getByRole("tab", { name: "地図" }).click();
    await page.screenshot({ path: `${screenshotDir}/04_geolocation_fallback.png`, fullPage: false });

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation(userLocation);
    await page.locator("#geo-retry").click();
    await expect(page.locator("#geo-banner")).toBeHidden();
    const recovered = await mapCenter(page);
    expect(Math.abs(recovered.lat - userLocation.latitude)).toBeLessThan(0.002);
  });
});

test.describe("パネルと出典", () => {
  test.use({
    geolocation: userLocation,
    permissions: ["geolocation"],
  });

  test("詳細・絞り込み・出典は同時に開かない", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    await page.locator(`.pin[data-facility-id="${spot.id}"]`).tap();
    await expect(page.locator("#detail")).toBeVisible();
    await page.getByRole("button", { name: "絞り込み" }).click();
    await expect(page.locator("#filter-panel")).toBeVisible();
    await expect(page.locator("#detail")).toBeHidden();
    await openInfo(page);
    await page.getByRole("button", { name: "出典とライセンス" }).click();
    await expect(page.locator("#source-panel")).toBeVisible();
    await expect(page.locator("#filter-panel")).toBeHidden();
    await expect(page.locator("#detail")).toBeHidden();
    const exact = facilities.filter((facility) => facility.address?.location_precision === "exact").length;
    const town = facilities.filter((facility) => facility.address?.location_precision === "approximate").length;
    expect(exact + town).toBe(facilities.length);
    await expect(page.locator("#source-panel")).toContainText(`番地まで一致したのは${exact}件`);
    await expect(page.locator("#source-panel")).toContainText(`町名までの概位は${town}件`);
  });

  test("一覧から選ぶと詳細を閉じるボタンにフォーカスする", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    await page.getByRole("tab", { name: "一覧" }).click();
    await page.locator(".card").first().click();
    await expect(page.locator("#detail")).toBeVisible();
    await expect(page.locator("#detail-close")).toBeFocused();
  });

  test("ライセンスは license_url へ、http(s) 以外はリンクにしない", async ({ page }) => {
    const edited = structuredClone(facilities);
    edited[0].source.dataset_url = "javascript:alert(1)";
    edited[0].source.license_url = "JavaScript:alert(2)";
    edited[1].source.dataset_url = "https://example.com/dataset";
    edited[1].source.license_url = "https://creativecommons.org/licenses/by/4.0/deed.ja";
    const sources = JSON.parse(fs.readFileSync("data/sources.json", "utf8")) as {
      sources: { provider: string; dataset_url: string; license_url: string; license: string }[];
    };
    sources.sources[0].dataset_url = "javascript:alert(3)";
    sources.sources[0].license_url = "data:text/html,hi";
    await page.route("**/data/facilities.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(edited) })
    );
    await page.route("**/data/sources.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(sources) })
    );
    await page.goto("/");
    await waitForMap(page);

    for (const facility of facilities) {
      expect(facility.source.dataset_url || "").toMatch(/^https:\/\//);
      expect(facility.source.license_url || "").toMatch(/^https:\/\//);
    }

    await page.getByRole("tab", { name: "一覧" }).click();
    await page.locator(`.card[data-facility-id="${edited[0].id}"]`).click();
    await expect(page.locator("#detail")).toBeVisible();
    const unsafeHrefs = await page.locator("#detail a").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") || "")
    );
    expect(unsafeHrefs.length).toBeGreaterThan(0);
    expect(unsafeHrefs.every((href) => href.startsWith("https://") || href.startsWith("http://"))).toBe(true);
    expect(unsafeHrefs.join(" ")).not.toMatch(/javascript:/i);
    await expect(page.locator("#detail")).toContainText(edited[0].source.license || "");

    await page.locator("#detail-close").click();
    await page.getByRole("tab", { name: "一覧" }).click();
    await page.locator(`.card[data-facility-id="${edited[1].id}"]`).click();
    await expect(page.locator("#detail a.badge")).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/deed.ja"
    );
    const datasetLink = page.locator('#detail a[href="https://example.com/dataset"]');
    await expect(datasetLink).toHaveCount(1);

    await openInfo(page);
    await page.getByRole("button", { name: "出典とライセンス" }).click();
    await expect(page.locator("#detail")).toBeHidden();
    const sourceHrefs = await page.locator("#source-body a").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") || "")
    );
    expect(sourceHrefs.length).toBeGreaterThan(0);
    expect(sourceHrefs.every((href) => href.startsWith("https://") || href.startsWith("http://"))).toBe(true);
    expect(sourceHrefs.join(" ")).not.toMatch(/javascript:|data:/i);
    await expect(page.locator("#source-body")).toContainText(sources.sources[0].provider);
  });
});

const farLocation = { latitude: 43.06417, longitude: 141.34694 };

test.describe("現在地の近くにピンがない", () => {
  test.use({
    geolocation: farLocation,
    permissions: ["geolocation"],
  });

  test("最寄りまでの距離と寄せるボタン", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    const nearest = nearestFacility(farLocation);
    const distance = formatDistance(nearest.distanceMeters);
    await expect(page.locator("#geo-banner")).toContainText("近くに子ども食堂がありません");
    await expect(page.locator("#geo-banner")).toContainText(nearest.facility.name);
    await expect(page.locator("#geo-banner")).toContainText(distance);
    await expect(page.locator("#geo-nearest")).toBeVisible();
    await expect(page.locator("#geo-retry")).toBeHidden();
    const nearestArea = await recordMapArea(page, "nearest");
    expect(nearestArea.ratio).toBeGreaterThanOrEqual(0.7);
    expect(await overlaps(page, "#geo-banner", ".zoom")).toBe(false);
    expect(await overlaps(page, "#geo-banner", ".leaflet-control-attribution")).toBe(false);
    expect(await pinsInsideMap(page)).toBe(0);
    await page.screenshot({ path: `${screenshotDir}/06_no_nearby.png`, fullPage: false });

    await page.getByRole("button", { name: "最寄りに寄せる" }).click();
    await expect(page.locator("#geo-banner")).toBeHidden();
    const center = await mapCenter(page);
    expect(Math.abs(center.lat - nearest.facility.lat)).toBeLessThan(0.002);
    expect(Math.abs(center.lng - nearest.facility.lng)).toBeLessThan(0.002);
    await expect(page.locator(`.pin[data-facility-id="${nearest.facility.id}"]`)).toBeVisible();
  });
});

async function openInfo(page: Page) {
  const toggle = page.locator("#info-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator("#info-panel")).toBeVisible();
}

async function recordMapArea(page: Page, label: string) {
  const metrics = await page.evaluate(() => {
    const map = document.querySelector("#map")!.getBoundingClientRect();
    const bar = document.querySelector(".top-bar")!.getBoundingClientRect();
    const header = document.querySelector(".top")!.getBoundingClientRect();
    const notice = document.querySelector("#notice-text") as HTMLElement;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      map: { width: map.width, height: map.height },
      ratio: map.height / window.innerHeight,
      topBarHeight: bar.height,
      headerHeight: header.height,
      noticeFits: notice.scrollWidth <= notice.clientWidth + 1,
    };
  });
  const file = "test-results/map-area.json";
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  prev[label] = metrics;
  fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  console.log(
    `map area ${label}: ${metrics.map.height}px / ${metrics.viewport.height}px = ${(metrics.ratio * 100).toFixed(1)}%`
  );
  return metrics;
}

async function overlaps(page: Page, aSel: string, bSel: string) {
  return page.evaluate(({ aSel, bSel }) => {
    const a = document.querySelector(aSel)?.getBoundingClientRect();
    const b = document.querySelector(bSel)?.getBoundingClientRect();
    if (!a || !b || a.width === 0 || b.width === 0) return false;
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }, { aSel, bSel });
}

async function waitForMap(page: Page) {
  await page.waitForFunction(() => window.__kodomoMap?.ready === true);
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll("#map .leaflet-tile")] as HTMLImageElement[];
    return tiles.length > 0 && tiles.every((tile) => tile.complete && tile.naturalWidth > 0);
  });
}

async function draggingEnabled(page: Page) {
  return page.evaluate(() => window.__kodomoMap.map.dragging.enabled());
}

async function pinsInsideMap(page: Page) {
  return page.evaluate(() => {
    const map = document.querySelector("#map");
    if (!map) return -1;
    const bounds = map.getBoundingClientRect();
    return [...document.querySelectorAll(".pin")].filter((pin) => {
      const box = pin.getBoundingClientRect();
      return box.width > 0 && box.bottom > bounds.top && box.top < bounds.bottom && box.right > bounds.left && box.left < bounds.right;
    }).length;
  });
}

async function touchPointer(
  page: Page,
  type: "pointerdown" | "pointerup" | "pointercancel" | "pointerleave",
  target: "map" | "documentElement",
  pointerId: number,
  isPrimary: boolean,
) {
  await page.evaluate(
    ({ type, target, pointerId, isPrimary }) => {
      const node = target === "map" ? document.querySelector("#map") : document.documentElement;
      if (!node) throw new Error("missing pointer target");
      node.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: "touch",
          isPrimary,
          bubbles: type !== "pointerleave",
          cancelable: true,
          clientX: 28,
          clientY: 28,
        }),
      );
    },
    { type, target, pointerId, isPrimary },
  );
}

function nearestFacility(origin: { latitude: number; longitude: number }) {
  const point = { lat: origin.latitude, lng: origin.longitude };
  let best = facilities[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const facility of facilities) {
    const distanceMeters = haversineMeters(point, facility);
    if (distanceMeters < bestDistance) {
      best = facility;
      bestDistance = distanceMeters;
    }
  }
  return { facility: best, distanceMeters: bestDistance };
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const radius = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

async function mapCenter(page: Page) {
  return page.evaluate(() => {
    const center = window.__kodomoMap.map.getCenter();
    return { lat: center.lat, lng: center.lng };
  });
}

async function drag(page: Page, from: { x: number; y: number }[], to: { x: number; y: number }[]) {
  const client = await page.context().newCDPSession(page);
  const points = (places: { x: number; y: number }[]) =>
    places.map((point, index) => ({ ...point, id: index + 1, radiusX: 2, radiusY: 2 }));
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    const midway = from.map((start, index) => ({
      x: start.x + ((to[index].x - start.x) * step) / steps,
      y: start.y + ((to[index].y - start.y) * step) / steps,
    }));
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(midway) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

function parseDistance(text: string) {
  const match = text.match(/([\d.]+)\s*(km|m)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[1]);
  return match[2] === "km" ? value * 1000 : value;
}

function pickDenseFacility(list: Facility[]) {
  let best = list[0];
  let bestCount = -1;
  for (const facility of list) {
    let count = 0;
    for (const other of list) {
      const dLat = (facility.lat - other.lat) * 111000;
      const dLng = (facility.lng - other.lng) * 91000;
      if (dLat * dLat + dLng * dLng < 700 * 700) count += 1;
    }
    if (count > bestCount) {
      best = facility;
      bestCount = count;
    }
  }
  return best;
}

declare global {
  interface Window {
    __kodomoMap: {
      map: {
        getCenter: () => { lat: number; lng: number };
        getZoom: () => number;
        dragging: { enabled: () => boolean };
      };
      ready: boolean;
      facilities: Facility[];
    };
  }
}
