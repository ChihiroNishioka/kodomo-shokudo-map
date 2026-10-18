#!/usr/bin/env python3
"""Build data/facilities.json from CC-licensed municipal open data.

Reads the raw files in data/raw, drops rows that would identify a private
home or that the publisher marked as unpublished, geocodes the rest with the
Geospatial Information Authority of Japan (GSI) address search API, and
writes the viewer JSON. Successful geocodes are cached in
data/geocode-cache.json so later runs do not repeat requests.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
CACHE_PATH = ROOT / "data" / "geocode-cache.json"
OUT_FACILITIES = ROOT / "data" / "facilities.json"
OUT_EXCLUSIONS = ROOT / "data" / "exclusions.json"
OUT_SOURCES = ROOT / "data" / "sources.json"

RETRIEVED = "2026-10-18"
GEOCODE_DELAY_SEC = 0.7
USER_AGENT = "kodomo-shokudo-map/0.1 (one-time geocode of CC BY open data)"
GSI_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch"

# Tokyo 23 wards present in the metropolitan catalog as 子ども食堂一覧, CC BY 4.0.
# dataset id -> (file names, municipality label, prefecture)
TOKYO_SOURCES = [
    ("t131059d3100000001", ["bunkyo.csv"], "文京区", "東京都"),
    ("t131067d3100000001", ["taito.csv"], "台東区", "東京都"),
    ("t131083d3100000001", ["koto.csv"], "江東区", "東京都"),
    ("t131091d3100000001", ["shinagawa.csv"], "品川区", "東京都"),
    ("t131105d3100000001", ["meguro.csv"], "目黒区", "東京都"),
    ("t131113d3100000001", ["ota.csv", "ota-add.csv"], "大田区", "東京都"),
    ("t131130d3100000001", ["shibuya.csv"], "渋谷区", "東京都"),
    ("t131148d3100000001", ["nakano.csv"], "中野区", "東京都"),
    ("t131156d3100000001", ["suginami.csv"], "杉並区", "東京都"),
    ("t131164d3100000001", ["toshima-b.csv", "toshima-a.csv"], "豊島区", "東京都"),
    ("t131181d3100000001", ["arakawa.csv"], "荒川区", "東京都"),
    ("t131199d3100000001", ["itabashi.csv"], "板橋区", "東京都"),
    ("t131202d3100000001", ["nerima.csv"], "練馬区", "東京都"),
    ("t131229d3100000001", ["katsushika.csv"], "葛飾区", "東京都"),
]

KANAGAWA_DATASET = "3612def4cb0fe303382cd734b1e7357b"
CC_BY_4 = "CC BY 4.0"
CC_BY_4_URL = "https://creativecommons.org/licenses/by/4.0/deed.ja"

MISSING_WARDS = [
    "千代田区",
    "中央区",
    "港区",
    "新宿区",
    "墨田区",
    "世田谷区",
    "北区",
    "足立区",
    "江戸川区",
]

WEEKDAY_CHAR_TO_CODE = {
    "月": "mon",
    "火": "tue",
    "水": "wed",
    "木": "thu",
    "金": "fri",
    "土": "sat",
    "日": "sun",
}
CODE_TO_LABEL = {v: k for k, v in WEEKDAY_CHAR_TO_CODE.items()}
WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

KANJI_DIGITS = "〇一二三四五六七八九"
PRIVATE_MARKERS = ("様方", "様宅", "自宅", "個人宅", "民家", "さん宅", "さん方")
UNPUBLISHED_MARKERS = ("非公開", "未公開")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
MOBILE_RE = re.compile(r"(?<!\d)0[789]0[-‐ー\s]?\d{4}[-‐ー\s]?\d{4}(?!\d)")
NAKANO_PLACEHOLDER = "中野区中野4-8-1"


def nfkc(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip()


def clean_key(key: str) -> str:
    key = (key or "").replace("\ufeff", "").strip()
    return re.sub(r"^[^\w\u3040-\u30ff\u4e00-\u9fff]+", "", key)


def cell_str(value) -> str:
    if value is None:
        return ""
    if hasattr(value, "hour") and not hasattr(value, "year"):
        return f"{value.hour:02d}:{value.minute:02d}"
    if hasattr(value, "isoformat") and hasattr(value, "year"):
        return value.isoformat()
    return nfkc(str(value))


def load_csv(path: Path) -> list[dict]:
    raw = path.read_bytes()
    text = None
    for encoding in ("utf-8-sig", "cp932", "utf-8"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise RuntimeError(f"cannot decode {path}")
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        item = {}
        for key, value in row.items():
            if key is None:
                continue
            item[clean_key(key)] = cell_str(value)
        if any(item.values()):
            rows.append(item)
    return rows


def load_kanagawa_kawasaki(path: Path) -> list[dict]:
    import openpyxl

    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = book[book.sheetnames[0]]
    iterator = sheet.iter_rows(values_only=True)
    header = [clean_key(cell_str(cell)) for cell in next(iterator)]
    rows = []
    for raw in iterator:
        if not raw or not any(raw):
            continue
        item = {}
        for index, key in enumerate(header):
            if not key or index >= len(raw):
                continue
            item[key] = cell_str(raw[index])
        city = item.get("市区町村名", "")
        if city.replace(" ", "") == "川崎市":
            rows.append(item)
    book.close()
    return rows


def normalize_address_text(value: str) -> str:
    text = nfkc(value)
    for dash in "‐‑‒–—―ー−":
        text = text.replace(dash, "-")
    text = text.replace("ノ", "の")
    text = re.sub(r"\s+", "", text)
    return text


def split_address(raw: str, prefecture: str, city: str) -> tuple[str, str]:
    """Return (geocode query, building or venue note).

    Repairs are limited to defects visible in the open-data files:
    a ward name repeated twice, a missing municipality, and the Shibuya
    CSV writing 代々木 as 代-木 (the iteration mark is absent; the kana
    reading on those rows is ヨヨギ).
    """
    text = nfkc(raw)
    for dash in "‐‑‒–—―ー−":
        text = text.replace(dash, "-")
    text = text.replace("　", " ")
    text = re.sub(r"[（(].*?[）)]", "", text)
    text = re.sub(r"\s+", " ", text).strip(" ,、")
    building = ""
    if " " in text:
        head, tail = text.split(" ", 1)
        if re.search(r"\d", head):
            text, building = head, tail.strip()
    if "渋谷" in text or city == "渋谷区":
        text = text.replace("代-木", "代々木")
    if city and f"{city}{city}" in text:
        text = text.replace(f"{city}{city}", city)
    if text and not text.startswith(("東京都", "神奈川県")):
        if text.startswith("川崎市"):
            text = "神奈川県" + text
        elif prefecture and not text.startswith(prefecture):
            text = prefecture + text
    if city and city not in text and text:
        if text.startswith(prefecture):
            text = prefecture + city + text[len(prefecture):]
        else:
            text = (prefecture or "") + city + text
    return text, building


def too_coarse(query: str) -> bool:
    """No lot number, or the publisher only gave a neighborhood."""
    if not query or not significant_numbers(query):
        return True
    return any(word in query for word in ("周辺", "付近", "一帯", "個別配送"))


def kanji_number(token: str) -> str:
    if not token:
        return ""
    if "十" in token:
        left, _, right = token.partition("十")
        tens = KANJI_DIGITS.index(left) if left else 1
        ones = KANJI_DIGITS.index(right) if right else 0
        if tens < 0 or ones < 0:
            return token
        return str(tens * 10 + ones)
    if all(char in KANJI_DIGITS for char in token):
        return "".join(str(KANJI_DIGITS.index(char)) for char in token)
    return token


def arabic_numbers(value: str) -> list[int]:
    text = nfkc(value)
    text = re.sub(
        r"[〇一二三四五六七八九十]+",
        lambda match: kanji_number(match.group(0)),
        text,
    )
    return [int(part) for part in re.findall(r"\d+", text)]


def blob(row: dict, *keys: str) -> str:
    return " ".join(row.get(key, "") for key in keys)


UNIT_ROOM_RE = re.compile(r"\d{2,4}\s*号室")
UNIT_AFTER_BUILDING_RE = re.compile(
    r"(マンション|コーポ|レジデンス|ハイツ|ハイム|パレス|ハウス)([^\d\n]{0,16}?)[ 　]*\d{2,4}(?!\d)"
)
FOURTH_LOT_RE = re.compile(r"(\d+-\d+-\d+)-\d{2,4}(?!\d)")


def redact_contacts(value: str) -> str:
    text = EMAIL_RE.sub("（メールは非掲載）", value or "")
    return MOBILE_RE.sub("（携帯電話は非掲載）", text)


def strip_unit_numbers(value: str) -> str:
    """Drop apartment unit numbers. The building address from open data stays."""
    text = UNIT_ROOM_RE.sub("", value or "")
    text = UNIT_AFTER_BUILDING_RE.sub(r"\1\2", text)
    text = FOURTH_LOT_RE.sub(r"\1", text)
    text = re.sub(r"[ 　]{2,}", " ", text)
    return text.strip(" 、")


def exclusion_reason(row: dict) -> str | None:
    place = blob(row, "住所", "方書", "GIS搭載用住所", "備考", "設置目的", "開催日時特記事項")
    locating = blob(row, "住所", "方書", "GIS搭載用住所")
    if any(marker in place for marker in PRIVATE_MARKERS):
        return "private_home"
    if EMAIL_RE.search(locating) or MOBILE_RE.search(locating) or "場所の詳細" in locating:
        return "address_unpublished"
    if any(marker in place for marker in UNPUBLISHED_MARKERS):
        return "address_unpublished"
    gis = normalize_address_text(row.get("GIS搭載用住所", ""))
    address = normalize_address_text(row.get("住所", ""))
    if gis.endswith(normalize_address_text(NAKANO_PLACEHOLDER)) and not address:
        return "placeholder_address"
    if not address and not gis:
        return "missing_address"
    if not row.get("名称"):
        return "missing_name"
    return None


def parse_float(value: str) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def plausible_point(lat: float | None, lng: float | None) -> bool:
    if lat is None or lng is None:
        return False
    return 34.8 <= lat <= 36.3 and 138.8 <= lng <= 140.3


def source_coordinates(rows: list[dict]) -> dict[int, tuple[float, float]]:
    points = {}
    for index, row in enumerate(rows):
        lat = parse_float(row.get("緯度", ""))
        lng = parse_float(row.get("経度", ""))
        if plausible_point(lat, lng):
            points[index] = (lat, lng)
    counts: dict[tuple[float, float], int] = defaultdict(int)
    for point in points.values():
        rounded = (round(point[0], 5), round(point[1], 5))
        counts[rounded] += 1
    trusted = {}
    for index, point in points.items():
        rounded = (round(point[0], 5), round(point[1], 5))
        # A coordinate repeated many times is a placeholder, not a venue.
        if counts[rounded] <= 3:
            trusted[index] = point
    return trusted


def weekday_codes_from_field(value: str) -> list[str]:
    compact = re.sub(r"[\s、,・/／]+", "", nfkc(value))
    if not compact:
        return []
    if "毎日" in compact or "毎曜" in compact:
        return WEEKDAY_ORDER[:]
    if re.fullmatch(r"[月火水木金土日]+", compact):
        codes = []
        for char in compact:
            code = WEEKDAY_CHAR_TO_CODE[char]
            if code not in codes:
                codes.append(code)
        return codes
    return []


def weekday_codes_from_prose(*values: str) -> list[str]:
    text = " ".join(nfkc(value) for value in values if value)
    if not text:
        return []
    if "毎日" in text or "毎曜" in text:
        return WEEKDAY_ORDER[:]
    codes = []
    for char, code in WEEKDAY_CHAR_TO_CODE.items():
        if f"{char}曜" in text or f"{char}・" in text:
            codes.append(code)
    return codes


def format_time(value: str) -> str:
    text = nfkc(value)
    match = re.search(r"(\d{1,2})[:：](\d{2})", text)
    if not match:
        return ""
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def time_span(row: dict) -> str:
    start = format_time(row.get("開催開始時間", ""))
    end = format_time(row.get("開催終了時間", ""))
    if start and end:
        return f"{start}〜{end}"
    if start:
        return f"{start}〜"
    return ""


def schedule_fragment(row: dict) -> tuple[list[str], str]:
    explicit = weekday_codes_from_field(row.get("開催曜日", ""))
    if not explicit:
        explicit = weekday_codes_from_prose(
            row.get("開催日", ""),
            row.get("開催日時特記事項", ""),
        )
    parts = []
    held = nfkc(row.get("開催日", ""))
    note = nfkc(row.get("開催日時特記事項", ""))
    span = time_span(row)
    if held:
        parts.append(held)
    elif explicit:
        labels = "・".join(CODE_TO_LABEL[code] + "曜" for code in explicit)
        parts.append(f"{labels} {span}".strip())
    elif span:
        parts.append(span)
    if note and note not in " ".join(parts):
        parts.append(note)
    return explicit, " ".join(part for part in parts if part).strip()


def fee_text(row: dict) -> str:
    note = nfkc(row.get("参加費特記事項", ""))
    labels = [
        ("参加費_幼児", "幼児"),
        ("参加費_小学生", "小学生"),
        ("参加費_中学生", "中学生"),
        ("参加費_高校生", "高校生"),
        ("参加費_大人", "大人"),
    ]
    chunks = []
    for key, label in labels:
        raw = nfkc(row.get(key, "")).rstrip("円")
        if not raw:
            continue
        if raw in {"0", "０", "無料"}:
            chunks.append(f"{label}無料")
        elif re.fullmatch(r"\d+", raw):
            chunks.append(f"{label}{raw}円")
    text = "・".join(chunks)
    if note:
        text = f"{text}（{note}）" if text else note
    return text


def targets_for(row: dict) -> list[str]:
    text = blob(row, "参加条件", "名称", "設置目的", "開催日時特記事項")
    if any(word in text for word in ("子ども限定", "子どもだけ", "小学生のみ", "中学生のみ")):
        targets = ["child"]
    elif any(word in text for word in ("どなたでも", "誰でも", "年齢問わず", "年齢を問わず")):
        targets = ["anyone", "child", "family"]
    else:
        targets = ["child", "family"]
    if any(word in text for word in ("高齢者", "シニア", "老人")):
        if "senior" not in targets:
            targets.append("senior")
    if "親子" in text and "family" not in targets:
        targets.append("family")
    return targets


def public_phone(row: dict) -> str:
    candidates = [
        (row.get("電話番号1", ""), row.get("電話番号1_連絡先備考", "")),
        (row.get("電話番号2", ""), row.get("電話番号2_連絡先備考", "")),
    ]
    for number, note in candidates:
        number = nfkc(number)
        note = nfkc(note)
        if not number or any(marker in number for marker in UNPUBLISHED_MARKERS):
            continue
        if any(marker in note for marker in ("様", "自宅", "個人")):
            continue
        digits = re.sub(r"\D", "", number)
        if digits.startswith(("090", "080", "070")):
            continue
        if len(digits) < 10:
            continue
        return number
    return "未確認"


def is_http_url(url: object) -> bool:
    """True only for http(s) URLs with a host. javascript: and data: are rejected."""
    if not isinstance(url, str):
        return False
    raw = url.strip()
    if not raw or any(char.isspace() for char in raw):
        return False
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme.lower() not in {"http", "https"}:
        return False
    return bool(parts.hostname)


def http_url_problems(facilities: list[dict], source_reports: list[dict]) -> list[str]:
    bad = []
    for facility in facilities:
        source = facility.get("source") or {}
        for key in ("dataset_url", "license_url"):
            if not is_http_url(source.get(key)):
                bad.append(f"{facility.get('id')}:{key}")
    for report in source_reports:
        for key in ("dataset_url", "license_url"):
            if not is_http_url(report.get(key)):
                bad.append(f"{report.get('provider')}:{key}")
    return bad


def public_url(row: dict) -> str:
    url = nfkc(row.get("URL", "")).strip()
    if is_http_url(url):
        return url
    return "未確認"


def organization_line(row: dict) -> str:
    name = nfkc(row.get("運営団体名", ""))
    if not name or name == nfkc(row.get("名称", "")):
        return ""
    if any(marker in name for marker in PRIVATE_MARKERS):
        return ""
    org_words = ("法人", "NPO", "会", "組合", "ネット", "食堂", "キッチン", "グループ", "チーム", "協議会", "委員会", "センター", "事業団", "協会", "財団", "社協", "協同")
    if any(word in name for word in org_words):
        return f"運営: {name}"
    return ""


def venue_line(row: dict, building: str) -> str:
    place = nfkc(row.get("方書", "")) or building
    if not place or any(marker in place for marker in UNPUBLISHED_MARKERS + PRIVATE_MARKERS):
        return ""
    return f"会場: {place}"


def stable_id(code: str, row: dict, address: str) -> str:
    raw_id = nfkc(row.get("ID", ""))
    raw_id = re.sub(r"[^0-9A-Za-z_-]", "", raw_id)
    if raw_id:
        return f"{code}-{raw_id}"
    digest = hashlib.sha1(f"{row.get('名称','')}|{address}".encode("utf-8")).hexdigest()[:8]
    return f"{code}-{digest}"


def load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    return {}


def save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def significant_numbers(query: str) -> list[int]:
    text = nfkc(query)
    text = re.sub(r"\d+\s*[FfＦ階]", "", text)
    text = re.sub(r"(ビル|マンション|アパート|タワー|ハウス|コーポ).*$", "", text)
    return arabic_numbers(text)


def classify_precision(query: str, title: str) -> str | None:
    query_numbers = significant_numbers(query)
    title_numbers = arabic_numbers(title)
    if not query_numbers or not title_numbers:
        return None
    if query_numbers[0] not in title_numbers:
        return None
    if all(number in title_numbers for number in query_numbers):
        return "exact"
    # A trailing room number (101, 402, …) does not make the building unknown.
    if len(query_numbers) >= 4 and all(number in title_numbers for number in query_numbers[:-1]):
        return "exact"
    return "approximate"


def ward_matches(query: str, title: str) -> bool:
    for token in ("区", "市"):
        found = re.findall(rf"([\u4e00-\u9fff]{{1,8}}{token})", query)
        if found and found[-1] not in title:
            return False
    return True


def town_variant(query: str, titles: list[str]) -> str | None:
    """If GSI only resolved the town, retry once with 町 or 字 restored.

    板橋区前野2-43-15 resolves to 前野町, and 渋谷区代官山7-9 to 代官山町,
    until the suffix from the GSI title is put back into the query.
    """
    match = re.search(r"([\u4e00-\u9fff]{2,12})(?=\d)", query)
    if not match:
        return None
    token = match.group(1)
    if token.endswith(("町", "村", "区", "市", "郡", "字", "丁目")):
        return None
    expansions = []
    for suffix in ("町", "字"):
        longer = token + suffix
        if any(longer in title for title in titles):
            expansions.append(longer)
    if len(expansions) != 1:
        return None
    return query[: match.start()] + expansions[0] + query[match.end() :]


def geocode(query: str, cache: dict) -> dict | None:
    key = normalize_address_text(query)
    if key in cache:
        cached = cache[key]
        if cached.get("miss"):
            return None
        precision = classify_precision(query, cached.get("title", ""))
        if precision:
            cached["precision"] = precision
        if cached.get("lat") is None:
            return None
        return cached
    url = GSI_URL + "?" + urllib.parse.urlencode({"q": query})
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    payload = None
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except Exception as error:  # noqa: BLE001 - retry network failures
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    time.sleep(GEOCODE_DELAY_SEC)
    if payload is None:
        print(f"  geocode error: {query}: {last_error}")
        return None
    features = payload if isinstance(payload, list) else payload.get("features") or []
    query_numbers = significant_numbers(query)
    best = None
    best_score = -1
    titles: list[str] = []
    for feature in features:
        title = ((feature.get("properties") or {}).get("title")) or ""
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2 or not title:
            continue
        lng, lat = float(coords[0]), float(coords[1])
        if not plausible_point(lat, lng) or not ward_matches(query, title):
            continue
        if title not in titles:
            titles.append(title)
        precision = classify_precision(query, title)
        if not precision:
            continue
        title_numbers = arabic_numbers(title)
        matched = sum(1 for number in query_numbers if number in title_numbers)
        score = matched * 10 + (5 if precision == "exact" else 0) + len(title_numbers)
        if score > best_score:
            best_score = score
            best = {
                "lat": lat,
                "lng": lng,
                "title": title,
                "precision": precision,
            }
    if best:
        cache[key] = best
    else:
        cache[key] = {"miss": True, "titles": titles[:5]}
    save_cache(cache)
    return best


def detail_address(query: str, prefecture: str, city: str, building: str, venue: str) -> str:
    text = query
    if text.startswith(prefecture):
        text = text[len(prefecture):]
    if text.startswith(city):
        text = text[len(city):]
    extra = venue or building
    if extra and extra not in text:
        text = f"{text} {extra}".strip()
    return text


def merge_rows(rows: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], dict] = {}
    order: list[tuple[str, str]] = []
    for row in rows:
        name = nfkc(row.get("名称", ""))
        address = normalize_address_text(row.get("住所", "") or row.get("GIS搭載用住所", ""))
        key = (name, address)
        if key not in grouped:
            grouped[key] = {
                "row": dict(row),
                "weekdays": [],
                "fragments": [],
                "targets": [],
            }
            order.append(key)
        bucket = grouped[key]
        # Prefer the row that actually has a weekday or a note.
        current_score = len(bucket["row"].get("開催曜日", "")) + len(bucket["row"].get("開催日", ""))
        new_score = len(row.get("開催曜日", "")) + len(row.get("開催日", ""))
        if new_score > current_score:
            bucket["row"] = dict(row)
        codes, fragment = schedule_fragment(row)
        for code in codes:
            if code not in bucket["weekdays"]:
                bucket["weekdays"].append(code)
        if fragment and fragment not in bucket["fragments"]:
            bucket["fragments"].append(fragment)
        for target in targets_for(row):
            if target not in bucket["targets"]:
                bucket["targets"].append(target)
        if not bucket["row"].get("URL") and row.get("URL"):
            bucket["row"]["URL"] = row["URL"]
        if not bucket["row"].get("電話番号1") and row.get("電話番号1"):
            bucket["row"]["電話番号1"] = row["電話番号1"]
            bucket["row"]["電話番号1_連絡先備考"] = row.get("電話番号1_連絡先備考", "")
    merged = []
    for key in order:
        bucket = grouped[key]
        item = bucket["row"]
        item["_weekdays"] = bucket["weekdays"]
        item["_fragments"] = bucket["fragments"]
        item["_targets"] = bucket["targets"]
        merged.append(item)
    return merged


def record_exclusion(exclusions: list[dict], *, name: str, municipality: str, reason: str, address: str = "") -> None:
    entry = {"name": name or "(名称なし)", "municipality": municipality, "reason": reason}
    # Unpublished and private-home rows must not carry the address into the repo.
    if address and reason in {"geocode_failed", "address_too_coarse"}:
        entry["address"] = address
    exclusions.append(entry)


def build() -> None:
    cache = load_cache()
    facilities = []
    exclusions: list[dict] = []
    source_reports = []
    seen_ids: set[str] = set()

    jobs = []
    for dataset_id, files, city, prefecture in TOKYO_SOURCES:
        rows = []
        for filename in files:
            path = RAW / filename
            if not path.exists():
                continue
            rows.extend(load_csv(path))
        jobs.append(
            {
                "dataset_id": dataset_id,
                "dataset_url": f"https://catalog.data.metro.tokyo.lg.jp/dataset/{dataset_id}",
                "license": CC_BY_4,
                "license_url": CC_BY_4_URL,
                "provider": city,
                "prefecture": prefecture,
                "city": city,
                "rows": rows,
                "area": "tokyo",
            }
        )
    jobs.append(
        {
            "dataset_id": KANAGAWA_DATASET,
            "dataset_url": f"https://catalog.opendata.pref.kanagawa.jp/dataset/{KANAGAWA_DATASET}",
            "license": "CC BY",
            "license_url": "https://creativecommons.org/licenses/by/4.0/deed.ja",
            "provider": "神奈川県（川崎市分）",
            "prefecture": "神奈川県",
            "city": "川崎市",
            "rows": load_kanagawa_kawasaki(RAW / "kanagawa.xlsx"),
            "area": "kawasaki",
            "note": "神奈川県オープンデータカタログの表示は「クリエイティブ・コモンズ-表示(CC-BY)」。掲載は公表の同意が得られた子ども食堂。",
        }
    )

    for job in jobs:
        rows = job["rows"]
        coords = source_coordinates(rows)
        kept_rows = []
        input_count = len(rows)
        reason_counts: dict[str, int] = defaultdict(int)
        for index, row in enumerate(rows):
            reason = exclusion_reason(row)
            if reason:
                record_exclusion(
                    exclusions,
                    name=row.get("名称", ""),
                    municipality=job["city"],
                    reason=reason,
                )
                reason_counts[reason] += 1
                continue
            if index in coords:
                row["_lat"], row["_lng"] = coords[index]
                row["_precision"] = "exact"
                row["_geocode_title"] = ""
            kept_rows.append(row)
        merged = merge_rows(kept_rows)
        geocode_failed = 0
        for row in merged:
            query, building = split_address(
                row.get("住所") or row.get("GIS搭載用住所", ""),
                job["prefecture"],
                job["city"],
            )
            lat = row.get("_lat")
            lng = row.get("_lng")
            precision = row.get("_precision", "exact")
            geocode_title = row.get("_geocode_title", "")
            if lat is None or lng is None:
                if too_coarse(query):
                    record_exclusion(
                        exclusions,
                        name=row.get("名称", ""),
                        municipality=job["city"],
                        reason="address_too_coarse",
                        address=query,
                    )
                    reason_counts["address_too_coarse"] += 1
                    continue
                hit = geocode(query, cache)
                if not hit:
                    titles = (cache.get(normalize_address_text(query)) or {}).get("titles") or []
                    variant = town_variant(query, titles)
                    if variant and variant != query and not too_coarse(variant):
                        query = variant
                        hit = geocode(query, cache)
                if not hit:
                    record_exclusion(
                        exclusions,
                        name=row.get("名称", ""),
                        municipality=job["city"],
                        reason="geocode_failed",
                        address=query,
                    )
                    geocode_failed += 1
                    reason_counts["geocode_failed"] += 1
                    continue
                lat = hit["lat"]
                lng = hit["lng"]
                precision = hit["precision"]
                geocode_title = hit["title"]
            weekdays = row.get("_weekdays") or []
            fragments = row.get("_fragments") or []
            frequency = " / ".join(fragments).strip()
            if not frequency:
                frequency = "開催曜日はオープンデータに記載がありません。訪問前に施設または自治体へ確認してください。"
            venue = venue_line(row, building)
            org = organization_line(row)
            description = " ".join(part for part in (venue, org) if part)
            facility_id = stable_id(job["dataset_id"], row, query)
            if facility_id in seen_ids:
                facility_id = facility_id + "-" + hashlib.sha1(query.encode("utf-8")).hexdigest()[:4]
            seen_ids.add(facility_id)
            span = time_span(row)
            facilities.append(
                {
                    "id": facility_id,
                    "name": nfkc(row.get("名称", "")),
                    "is_sample": False,
                    "description": description,
                    "address": {
                        "prefecture": job["prefecture"],
                        "city": job["city"] if job["area"] == "tokyo" else "川崎市",
                        "detail": detail_address(query, job["prefecture"], job["city"] if job["area"] == "tokyo" else "川崎市", building, nfkc(row.get("方書", "")) if venue else ""),
                        "location_precision": precision,
                    },
                    "lat": round(lat, 6),
                    "lng": round(lng, 6),
                    "schedule": {
                        "frequency_text": frequency,
                        "weekdays": weekdays,
                        "time_text": span,
                        "notes": "開催日・開催時間は変更される場合があります。訪問前に必ず施設・自治体にご確認ください。",
                    },
                    "target": row.get("_targets") or ["child", "family"],
                    "fee_text": fee_text(row),
                    "contact": {"phone": public_phone(row), "url": public_url(row)},
                    "source": {
                        "provider": job["provider"],
                        "license": job["license"],
                        "license_url": job["license_url"],
                        "dataset_url": job["dataset_url"],
                        "dataset_id": job["dataset_id"],
                        "retrieved": RETRIEVED,
                        "last_verified": RETRIEVED,
                        "geocoder": "国土地理院 住所検索" if geocode_title else "原データの緯度経度",
                    },
                }
            )
        produced = sum(1 for facility in facilities if facility["source"]["dataset_id"] == job["dataset_id"])
        source_reports.append(
            {
                "provider": job["provider"],
                "prefecture": job["prefecture"],
                "city": job["city"],
                "license": job["license"],
                "license_url": job["license_url"],
                "dataset_url": job["dataset_url"],
                "dataset_id": job["dataset_id"],
                "input_rows": input_count,
                "published_rows": produced,
                "excluded": dict(reason_counts),
                "note": job.get("note", ""),
                "retrieved": RETRIEVED,
            }
        )
        print(f"{job['provider']}: in={input_count} out={produced} excluded={dict(reason_counts)}")

    deduped = []
    seen_exclusions = set()
    for item in exclusions:
        key = (item["name"], item["municipality"], item["reason"], item.get("address", ""))
        if key in seen_exclusions:
            continue
        seen_exclusions.add(key)
        deduped.append(item)
    exclusions = deduped

    facilities.sort(key=lambda facility: (facility["address"]["prefecture"], facility["address"]["city"], facility["name"]))
    for facility in facilities:
        facility["description"] = strip_unit_numbers(redact_contacts(facility["description"]))
        facility["schedule"]["frequency_text"] = redact_contacts(facility["schedule"]["frequency_text"])
        facility["schedule"]["notes"] = redact_contacts(facility["schedule"]["notes"])
        facility["fee_text"] = redact_contacts(facility["fee_text"])
        facility["address"]["detail"] = strip_unit_numbers(redact_contacts(facility["address"]["detail"]))
    text = json.dumps(facilities, ensure_ascii=False)
    problems = []
    if "様方" in text or "様宅" in text:
        problems.append("private-home marker")
    for label, pattern in (("email", EMAIL_RE), ("mobile", MOBILE_RE)):
        found = pattern.search(text)
        if found:
            problems.append(f"{label}:{found.group(0)}")
            index = found.start()
            print(text[max(0, index - 100): index + 120].replace("\n", " "))
    problems.extend(f"url:{item}" for item in http_url_problems(facilities, source_reports))
    if problems:
        raise SystemExit("refusing to write facilities.json: " + ", ".join(problems))

    OUT_FACILITIES.write_text(json.dumps(facilities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OUT_EXCLUSIONS.write_text(json.dumps(exclusions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {
        "retrieved": RETRIEVED,
        "coverage": "東京都のうち、東京都オープンデータカタログに CC BY 4.0 の子ども食堂一覧CSVがある14区と、神奈川県オープンデータ（CC BY）の川崎市分。",
        "published_count": len(facilities),
        "excluded_count": len(exclusions),
        "excluded_by_reason": dict(defaultdict(int, {item["reason"]: 0 for item in exclusions})),
        "sources": source_reports,
        "not_included": [
            {
                "area": ward,
                "reason": "東京都オープンデータカタログを『子ども食堂』で全件検索したが、子ども食堂一覧データセットが無かった。区公式サイトの一般ページはオープンデータ利用規約の対象外で、転載の許諾を確認できないため自動取得していない。",
            }
            for ward in MISSING_WARDS
        ]
        + [
            {
                "area": "かわさきこども食堂ネットワーク（jimdofree）",
                "reason": "オープンデータではなく、再利用してよいという許諾を確認できないため使っていない。川崎市分は神奈川県の同意取得済みオープンデータを使った。",
            },
            {
                "area": "むすびえ全国こども食堂マップ",
                "reason": "全国一括データの二次利用条件をこの作業では確認できなかったため使っていない。",
            },
            {
                "area": "OpenStreetMap",
                "reason": "子ども食堂の開催曜日まで揃った、運営者の掲載同意が分かる抽出が得られないため、地図の背景タイル以外には使っていない。",
            },
        ],
        "geocoder": {
            "name": "国土地理院 住所検索API",
            "url": GSI_URL,
            "note": "原データに信頼できる緯度経度が無い行だけを、1件あたり約0.7秒空けて検索した。結果（不一致を含む）は data/geocode-cache.json に保存し、再実行では再リクエストしない。住所の補修は、区名の重複除去、データセットの市区町村名の補完、渋谷区CSVで欠落している代々木の々の復元、国土地理院の応答が町名止まりだったときの町・字の一回だけ再検索に限る。",
        },
    }
    counts: dict[str, int] = defaultdict(int)
    for item in exclusions:
        counts[item["reason"]] += 1
    print("geocode failures:")
    for item in exclusions:
        if item["reason"] == "geocode_failed":
            print(" -", item["municipality"], item["name"], item.get("address", ""))
    summary["excluded_by_reason"] = dict(counts)
    OUT_SOURCES.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"published {len(facilities)} excluded {len(exclusions)} {dict(counts)}")
    save_cache(cache)


def self_test() -> None:
    assert is_http_url("https://creativecommons.org/licenses/by/4.0/deed.ja")
    assert is_http_url("http://example.com/data")
    assert is_http_url("HTTPS://example.com/a")
    assert is_http_url(" https://example.com/a")
    assert not is_http_url("javascript:alert(1)")
    assert not is_http_url("JavaScript:alert(1)")
    assert not is_http_url("data:text/html,hi")
    assert not is_http_url("https:example.com")
    assert not is_http_url("//example.com/a")
    assert not is_http_url("https://")
    assert not is_http_url("")
    assert not is_http_url(None)
    assert not is_http_url("https://example.com/a b")
    sample = [{"id": "x", "source": {"dataset_url": "javascript:alert(1)", "license_url": "https://example.com"}}]
    assert http_url_problems(sample, []) == ["x:dataset_url"]
    print("url self-test ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        self_test()
    else:
        build()
