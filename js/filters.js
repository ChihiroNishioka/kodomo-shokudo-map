export const WEEKDAYS = [
  ["mon", "月"],
  ["tue", "火"],
  ["wed", "水"],
  ["thu", "木"],
  ["fri", "金"],
  ["sat", "土"],
  ["sun", "日"],
];

export const TARGETS = [
  ["child", "こども"],
  ["family", "親子"],
  ["senior", "高齢者"],
  ["anyone", "誰でも"],
];

const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);
const TARGET_LABEL = Object.fromEntries(TARGETS);

export function weekdayLabel(code) {
  return WEEKDAY_LABEL[code] || code;
}

export function targetLabel(code) {
  return TARGET_LABEL[code] || code;
}

export function matchesFacility(facility, filters) {
  const weekdays = filters.weekdays;
  const targets = filters.targets;
  const dayOk =
    weekdays.size === 0 ||
    (facility.schedule.weekdays || []).some((day) => weekdays.has(day));
  const targetOk =
    targets.size === 0 ||
    (facility.target || []).some((target) => targets.has(target));
  return dayOk && targetOk;
}

export function formatWeekdays(codes) {
  if (!codes || !codes.length) return "曜日の記載なし";
  if (codes.length === 7) return "毎日";
  return codes.map((code) => `${weekdayLabel(code)}曜`).join("・");
}

export function formatTargets(codes) {
  if (!codes || !codes.length) return "記載なし";
  return codes.map((code) => targetLabel(code)).join("・");
}
