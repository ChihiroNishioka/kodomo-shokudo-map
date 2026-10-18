import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

type Facility = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  is_sample: boolean;
  contact: { phone: string; url: string };
  source: { license: string };
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
    await expect(page.locator("#notice-text")).toContainText(
      "開催日・開催時間は変更される場合があります。訪問前に必ず施設・自治体にご確認ください"
    );
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
  });
});

test.describe("現在地が取れない", () => {
  test.use({ permissions: [] });

  test("フォールバック中心と再試行", async ({ page, context }) => {
    await page.goto("/");
    await waitForMap(page);
    await expect(page.locator("#geo-banner")).toContainText("現在地が取得できません");
    await expect(page.locator("#geo-retry")).toBeVisible();
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

async function waitForMap(page: Page) {
  await page.waitForFunction(() => window.__kodomoMap?.ready === true);
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll("#map .leaflet-tile")] as HTMLImageElement[];
    return tiles.length > 0 && tiles.every((tile) => tile.complete && tile.naturalWidth > 0);
  });
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
