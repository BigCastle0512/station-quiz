"""
東京23区の駅データを OpenStreetMap (Overpass API / Nominatim) から収集し、
data/stations.json を生成するビルドスクリプト。

実行: python scripts/build_stations.py

中間データ (data/raw_stations.json, data/raw_routes.json, data/ward_cache.json) は
キャッシュとして保存され、再実行時はネットワークアクセスをスキップする。
"""
from __future__ import annotations

import json
import math
import re
import time
import urllib.request
import urllib.parse
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

RAW_STATIONS_PATH = DATA_DIR / "raw_stations.json"
RAW_ROUTES_PATH = DATA_DIR / "raw_routes.json"
WARD_CACHE_PATH = DATA_DIR / "ward_cache.json"
OUTPUT_PATH = DATA_DIR / "stations.json"
LINES_OUTPUT_PATH = DATA_DIR / "lines.json"

# operator/network タグ(表記ゆれが多い)を会社単位のグループ名に正規化する。
# 先頭から順にキーワード一致で判定するため、より具体的なものを先に置く。
OPERATOR_RULES = [
    ("東日本旅客鉄道", "JR"), ("東海旅客鉄道", "JR"), ("西日本旅客鉄道", "JR"),
    ("JR東日本", "JR"), ("JR東海", "JR"),
    ("東京地下鉄", "東京メトロ"), ("Tokyo Metro", "東京メトロ"), ("東京メトロ", "東京メトロ"),
    ("東京都交通局", "都営地下鉄"),
    ("東急電鉄", "東急電鉄"),
    ("小田急電鉄", "小田急電鉄"),
    ("京王", "京王電鉄"),
    ("西武鉄道", "西武鉄道"),
    ("東武", "東武鉄道"),
    ("新京成電鉄", "京成電鉄"), ("京成電鉄", "京成電鉄"),
    ("京浜急行電鉄", "京浜急行電鉄"),
    ("北総", "北総鉄道"),
    ("横浜市交通局", "横浜市交通局"),
    ("首都圏新都市鉄道", "つくばエクスプレス"),
    ("ゆりかもめ", "ゆりかもめ"),
    ("Tokyo Waterfront", "りんかい線"),
    ("埼玉高速鉄道", "埼玉高速鉄道"),
    ("相模鉄道", "相鉄"),
]


def normalize_operator(raw: str) -> str:
    first = raw.split(";")[0].strip()
    for keyword, group in OPERATOR_RULES:
        if keyword in first:
            return group
    return "その他"

# 23区+隣接自治体を広めに含むbbox (south, west, north, east)
BBOX = (35.53, 139.56, 35.82, 139.92)
BBOX_STR = ",".join(str(v) for v in BBOX)

WARD_23 = {
    "千代田区", "中央区", "港区", "新宿区", "文京区", "台東区", "墨田区", "江東区",
    "品川区", "目黒区", "大田区", "世田谷区", "渋谷区", "中野区", "杉並区", "豊島区",
    "北区", "荒川区", "板橋区", "練馬区", "足立区", "葛飾区", "江戸川区",
}

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

TERMINALS = {
    "新宿": (35.6896, 139.7006),
    "東京": (35.6812, 139.7671),
    "渋谷": (35.6580, 139.7016),
}


def overpass_query(query: str, timeout: int = 150) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for round_num in range(4):
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                req = urllib.request.Request(
                    endpoint, data=data,
                    headers={"User-Agent": "station-quiz-app/1.0 (personal study project)"},
                )
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    body = resp.read()
                result = json.loads(body)
                if result.get("elements"):
                    return result
                last_error = RuntimeError("empty result")
            except Exception as e:  # noqa: BLE001 - retry any transient failure (server congestion)
                last_error = e
            print(f"  ({endpoint} failed: {last_error}; retrying...)")
            time.sleep(8)
    raise RuntimeError(f"Overpass query failed on all endpoints after retries: {last_error}")


def fetch_raw_stations() -> list[dict]:
    if RAW_STATIONS_PATH.exists():
        return json.loads(RAW_STATIONS_PATH.read_text(encoding="utf-8"))
    query = f'[out:json][timeout:90];node["railway"="station"]({BBOX_STR});out body;'
    result = overpass_query(query)
    elements = result["elements"]
    RAW_STATIONS_PATH.write_text(json.dumps(elements, ensure_ascii=False, indent=2), encoding="utf-8")
    return elements


def fetch_raw_routes() -> list[dict]:
    if RAW_ROUTES_PATH.exists():
        return json.loads(RAW_ROUTES_PATH.read_text(encoding="utf-8"))
    query = f'''[out:json][timeout:180];
(
  relation["route"="subway"]({BBOX_STR});
  relation["route"="train"]({BBOX_STR});
  relation["route"="light_rail"]({BBOX_STR});
  relation["route"="tram"]({BBOX_STR});
  relation["route"="monorail"]({BBOX_STR});
);
out body;
>;
out skel qt;'''
    result = overpass_query(query, timeout=200)
    elements = result["elements"]
    RAW_ROUTES_PATH.write_text(json.dumps(elements, ensure_ascii=False, indent=2), encoding="utf-8")
    return elements


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def dedupe_stations(raw_nodes: list[dict]) -> list[dict]:
    """同じ駅名で近接するノード(事業者ごとに分かれているもの)を1つにまとめる。"""
    groups: list[dict] = []
    for node in raw_nodes:
        tags = node.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        lat, lon = node["lat"], node["lon"]
        merged = False
        for g in groups:
            if g["name"] == name and haversine_km(lat, lon, g["lat"], g["lon"]) < 0.35:
                g["node_ids"].append(node["id"])
                g["lats"].append(lat)
                g["lons"].append(lon)
                g["lat"] = sum(g["lats"]) / len(g["lats"])
                g["lon"] = sum(g["lons"]) / len(g["lons"])
                merged = True
                break
        if not merged:
            groups.append({
                "name": name,
                "name_en": tags.get("name:en", ""),
                "lat": lat,
                "lon": lon,
                "lats": [lat],
                "lons": [lon],
                "node_ids": [node["id"]],
            })
    for g in groups:
        del g["lats"]
        del g["lons"]
    return groups


def load_ward_cache() -> dict:
    if WARD_CACHE_PATH.exists():
        return json.loads(WARD_CACHE_PATH.read_text(encoding="utf-8"))
    return {}


def save_ward_cache(cache: dict) -> None:
    WARD_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def reverse_geocode_ward(lat: float, lon: float) -> str | None:
    url = (
        "https://nominatim.openstreetmap.org/reverse?format=jsonv2"
        f"&lat={lat}&lon={lon}&zoom=14&accept-language=ja"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "station-quiz-app/1.0 (personal study project)"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    return data.get("address", {}).get("city")


def annotate_wards(stations: list[dict]) -> None:
    cache = load_ward_cache()
    changed = False
    for i, st in enumerate(stations):
        key = f"{st['lat']:.5f},{st['lon']:.5f}"
        if key in cache:
            st["ward"] = cache[key]
            continue
        try:
            ward = reverse_geocode_ward(st["lat"], st["lon"])
        except Exception:
            ward = None
        st["ward"] = ward
        cache[key] = ward
        changed = True
        time.sleep(1.1)  # Nominatim usage policy: max 1 req/sec
        if (i + 1) % 25 == 0:
            print(f"  reverse geocoded {i + 1}/{len(stations)}")
            save_ward_cache(cache)
    if changed:
        save_ward_cache(cache)


ARROW_CHARS = ("=>", "->", "⇔", "↔", "→", "←")
JAPANESE_CHAR_RE = re.compile(r"[぀-ヿ一-鿿]")
LINE_SUFFIXES = ("線", "ライン", "ライナー")
LINE_NAME_WHITELIST = {"ゆりかもめ"}
# OSM の name タグに既知の誤り・表記ゆれがあるものへの手動補正
LINE_NAME_OVERRIDES = {"南新宿ライン": "湘南新宿ライン"}

# 複数の事業者ノードが至近距離に分かれていて自動マッチングが漏れる巨大駅、
# またはOSMのリレーションにstopとして含まれていない駅への補正
MANUAL_LINE_ADDITIONS = {
    "新宿": ["JR山手線", "東京メトロ丸ノ内線", "都営新宿線", "都営大江戸線", "西武鉄道西武新宿線"],
    "千歳船橋": ["小田急電鉄小田原線"],
    "喜多見": ["小田急電鉄小田原線"],
    "祖師ヶ谷大蔵": ["小田急電鉄小田原線"],
}


def clean_line_name(raw_name: str) -> str | None:
    """方向別・直通運転の合成名・臨時列車名など、路線名として使いにくいものを正規化・除外する。"""
    name = re.sub(r"^列車\s*", "", raw_name)
    # "線: 横浜 => 渋谷" のようにコロンの前にスペースが無い表記もあるため、前後の空白を許容して分割する
    name = re.split(r"\s*[:：]\s*", name, maxsplit=1)[0]
    name = re.sub(r"[（(].*?[）)]", "", name).strip()
    name = re.sub(r"(上り|下り|内回り|外回り)$", "", name).strip()
    name = re.sub(
        r"\s*(各駅停車|快速|通勤快速|急行|通勤急行|準急|特急|快特|区間急行|特別快速|中央特快|青梅特快|特別区間急行|普通|各停)$",
        "", name,
    ).strip()
    # "路線名 種別" のように、路線名らしき接尾辞の直後にスペース区切りで種別語が
    # 続くパターンを汎用的に切り落とす(個別の種別名を列挙しきれないため)
    if " " in name:
        prefix = name.rsplit(" ", 1)[0]
        if prefix.endswith(LINE_SUFFIXES):
            name = prefix
    if not name or any(a in name for a in ARROW_CHARS) or "Stopping service" in name:
        return None
    if " - " in name or "•" in name or "直通運転" in name:
        return None  # 「◯◯線 - ××線直通」のような直通運転の説明的な名前を除外
    if not JAPANESE_CHAR_RE.search(name):
        return None
    if name not in LINE_NAME_WHITELIST and not name.endswith(LINE_SUFFIXES):
        return None  # 臨時・named limited express など「線」を名乗らない列車名を除外
    return LINE_NAME_OVERRIDES.get(name, name)


def candidate_line_name_parts(raw_name: str) -> list[str]:
    """直通運転名(例: 「東武東上線 - 副都心線 - 東急東横線・みなとみらい線 直通運転」)から
    既知の路線名を復元するための候補文字列を列挙する。"""
    parts = []
    for chunk in raw_name.split(" - "):
        for sub in chunk.split("・"):
            cleaned = clean_line_name(sub)
            if cleaned:
                parts.append(cleaned)
    return parts


def build_line_membership(stations: list[dict], route_elements: list[dict]) -> None:
    def nearest_station(lat, lon, max_km=0.25):
        best, best_d = None, max_km
        for st in stations:
            d = haversine_km(lat, lon, st["lat"], st["lon"])
            if d < best_d:
                best, best_d = st, d
        return best

    nodes_by_id = {e["id"]: e for e in route_elements if e["type"] == "node"}
    ways_by_id = {e["id"]: e for e in route_elements if e["type"] == "way"}
    relations = [e for e in route_elements if e["type"] == "relation"]

    def member_latlon(member):
        if member["type"] == "node":
            node = nodes_by_id.get(member["ref"])
            return (node["lat"], node["lon"]) if node and "lat" in node else None
        if member["type"] == "way":
            way = ways_by_id.get(member["ref"])
            if not way:
                return None
            coords = [(n["lat"], n["lon"]) for nid in way.get("nodes", []) if (n := nodes_by_id.get(nid)) and "lat" in n]
            if not coords:
                return None
            return (sum(c[0] for c in coords) / len(coords), sum(c[1] for c in coords) / len(coords))
        return None

    for st in stations:
        st["lines"] = set()
        st["adjacent"] = {}

    def tag_stops(rel, line_name):
        ordered_stations = []
        for member in rel.get("members", []):
            if member.get("role") not in ("stop", "stop_entry_only", "platform"):
                continue
            latlon = member_latlon(member)
            if not latlon:
                continue
            matched = nearest_station(*latlon)
            if matched and (not ordered_stations or ordered_stations[-1] is not matched):
                ordered_stations.append(matched)

        for st in ordered_stations:
            st["lines"].add(line_name)

        for i, st in enumerate(ordered_stations):
            neighbors = st["adjacent"].setdefault(line_name, set())
            if i > 0:
                neighbors.add(ordered_stations[i - 1]["name"])
            if i < len(ordered_stations) - 1:
                neighbors.add(ordered_stations[i + 1]["name"])

    known_line_names = set()
    unmatched = []
    for rel in relations:
        raw_name = rel.get("tags", {}).get("name")
        if not raw_name:
            continue
        line_name = clean_line_name(raw_name)
        if line_name:
            known_line_names.add(line_name)
        else:
            unmatched.append((raw_name, rel))

    for rel in relations:
        raw_name = rel.get("tags", {}).get("name")
        if not raw_name:
            continue
        line_name = clean_line_name(raw_name)
        if line_name:
            tag_stops(rel, line_name)

    # 直通運転などで名前が弾かれたリレーションでも、分割した一部が既知の路線名と
    # 一致すればその路線の駅として扱う(build_line_geometryと同じ救済ロジック)。
    for raw_name, rel in unmatched:
        for candidate in candidate_line_name_parts(raw_name):
            if candidate in known_line_names:
                tag_stops(rel, candidate)
                break

    for st in stations:
        st["lines"] = sorted(st["lines"])
        st["adjacent"] = {line: sorted(names) for line, names in st["adjacent"].items()}


# 種別名にこれらの語を含むリレーションは急行・快速などの優等列車の停車駅を表す。
# 「各駅停車」「普通」など各停系は含めない(=優等種別ではない扱い)。
EXPRESS_KEYWORDS = (
    "快速", "急行", "準急", "特急", "快特", "ライナー", "エクスプレス", "特快",
)
LOCAL_ONLY_KEYWORDS = ("各駅停車", "各停", "普通")


def mark_express_stops(stations: list[dict], route_elements: list[dict]) -> None:
    """優等列車(急行・快速など)が停車する駅に is_express フラグを立てる。"""

    def nearest_station(lat, lon, max_km=0.25):
        best, best_d = None, max_km
        for st in stations:
            d = haversine_km(lat, lon, st["lat"], st["lon"])
            if d < best_d:
                best, best_d = st, d
        return best

    nodes_by_id = {e["id"]: e for e in route_elements if e["type"] == "node"}
    ways_by_id = {e["id"]: e for e in route_elements if e["type"] == "way"}
    relations = [e for e in route_elements if e["type"] == "relation"]

    def member_latlon(member):
        if member["type"] == "node":
            node = nodes_by_id.get(member["ref"])
            return (node["lat"], node["lon"]) if node and "lat" in node else None
        if member["type"] == "way":
            way = ways_by_id.get(member["ref"])
            if not way:
                return None
            coords = [(n["lat"], n["lon"]) for nid in way.get("nodes", []) if (n := nodes_by_id.get(nid)) and "lat" in n]
            if not coords:
                return None
            return (sum(c[0] for c in coords) / len(coords), sum(c[1] for c in coords) / len(coords))
        return None

    for st in stations:
        st["is_express"] = False

    for rel in relations:
        raw_name = rel.get("tags", {}).get("name", "")
        if any(kw in raw_name for kw in LOCAL_ONLY_KEYWORDS):
            continue
        if not any(kw in raw_name for kw in EXPRESS_KEYWORDS):
            continue
        for member in rel.get("members", []):
            if member.get("role") not in ("stop", "stop_entry_only", "platform"):
                continue
            latlon = member_latlon(member)
            if not latlon:
                continue
            matched = nearest_station(*latlon)
            if matched:
                matched["is_express"] = True


# 薄い背景地図上でも視認できるよう、明るすぎる・淡すぎる色は避けた濃色パレット
FALLBACK_COLORS = [
    "#c0392b", "#1f618d", "#1e8449", "#8e44ad", "#d35400", "#117864", "#a1045a",
    "#5d4037", "#283593", "#6d4c41", "#00695c", "#4527a0", "#ad1457", "#37474f",
]


def build_line_geometry(route_elements: list[dict]) -> dict:
    """路線ごとの色・運営会社・線路の座標列(地図描画用)をまとめる。"""
    nodes_by_id = {e["id"]: e for e in route_elements if e["type"] == "node"}
    ways_by_id = {e["id"]: e for e in route_elements if e["type"] == "way"}
    relations = [e for e in route_elements if e["type"] == "relation"]

    # プラットフォームなど線路そのものではない役割のみ除外する。複線区間などで
    # 使われる "north"/"south" のような方向別ロールも実際の線路なので含める。
    NON_TRACK_WAY_ROLES = {"platform", "platform_entry_only", "platform_exit_only", "stop_area"}

    def way_segments(rel) -> list[list[list[float]]]:
        segments = []
        for member in rel.get("members", []):
            if member["type"] != "way" or member.get("role") in NON_TRACK_WAY_ROLES:
                continue
            way = ways_by_id.get(member["ref"])
            if not way:
                continue
            coords = [
                [round(n["lat"], 5), round(n["lon"], 5)]
                for nid in way.get("nodes", [])
                if (n := nodes_by_id.get(nid)) and "lat" in n
            ]
            # 23区の想定範囲(+マージン)を完全に外れるセグメントは間引く(小田急小田原線など郊外まで伸びる路線の肥大化を防ぐ)
            if len(coords) >= 2 and any(
                BBOX[0] - 0.05 <= lat <= BBOX[2] + 0.05 and BBOX[1] - 0.05 <= lon <= BBOX[3] + 0.05
                for lat, lon in coords
            ):
                segments.append(coords)
        return segments

    lines: dict = {}
    unmatched: list[tuple[str, dict]] = []

    for rel in relations:
        tags = rel.get("tags", {})
        raw_name = tags.get("name")
        if not raw_name:
            continue
        line_name = clean_line_name(raw_name)
        if not line_name:
            unmatched.append((raw_name, rel))
            continue

        entry = lines.setdefault(line_name, {"color": None, "operator": None, "segments": []})
        if not entry["color"] and tags.get("colour"):
            entry["color"] = tags["colour"]
        if not entry["operator"]:
            raw_op = tags.get("operator") or tags.get("network")
            if raw_op:
                entry["operator"] = normalize_operator(raw_op)
        entry["segments"].extend(way_segments(rel))

    # 直通運転などを理由に路線名として弾かれたリレーションでも、実在の路線区間を含んでいることが多い
    # (例: 「東京メトロ日比谷線 - 東武スカイツリーライン直通運転」)。分割した一部が
    # 既知の路線名に一致すれば、その路線の線路データとして取り込む。
    for raw_name, rel in unmatched:
        for candidate in candidate_line_name_parts(raw_name):
            if candidate in lines:
                lines[candidate]["segments"].extend(way_segments(rel))
                break

    for i, (name, entry) in enumerate(sorted(lines.items())):
        if not entry["color"]:
            entry["color"] = FALLBACK_COLORS[i % len(FALLBACK_COLORS)]
        if not entry["operator"]:
            entry["operator"] = "その他"

    return {name: e for name, e in lines.items() if e["segments"]}


def main():
    print("1. 駅ノードを取得中...")
    raw_stations = fetch_raw_stations()
    print(f"   {len(raw_stations)} 件のノードを取得")

    print("2. 路線データを取得中...")
    raw_routes = fetch_raw_routes()
    print(f"   {len(raw_routes)} 件の要素を取得")

    print("3. 重複駅を統合中...")
    stations = dedupe_stations(raw_stations)
    print(f"   {len(stations)} 駅に統合")

    print("4. 区を判定中 (Nominatim逆ジオコーディング、時間がかかります)...")
    annotate_wards(stations)

    stations = [s for s in stations if s.get("ward") in WARD_23]
    print(f"   23区内: {len(stations)} 駅")

    print("5. 路線・隣接駅を紐付け中...")
    build_line_membership(stations, raw_routes)
    for st in stations:
        for line in MANUAL_LINE_ADDITIONS.get(st["name"], []):
            if line not in st["lines"]:
                st["lines"].append(line)

    print("5.5. 優等列車の停車駅を判定中...")
    mark_express_stops(stations, raw_routes)
    print(f"   優等停車駅: {sum(1 for s in stations if s['is_express'])} / {len(stations)}")

    print("6. 主要ターミナル駅までの距離を計算中...")
    for st in stations:
        st["distance_km"] = {
            term: round(haversine_km(st["lat"], st["lon"], tlat, tlon), 2)
            for term, (tlat, tlon) in TERMINALS.items()
        }

    for st in stations:
        st["id"] = f"{st['name']}_{round(st['lat'], 4)}_{round(st['lon'], 4)}"
        for k in ("node_ids",):
            del st[k]

    stations.sort(key=lambda s: s["name"])
    OUTPUT_PATH.write_text(json.dumps(stations, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完了: {OUTPUT_PATH} に {len(stations)} 駅を出力しました")

    print("7. 路線図(色・経路)を生成中...")
    lines = build_line_geometry(raw_routes)
    LINES_OUTPUT_PATH.write_text(json.dumps(lines, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完了: {LINES_OUTPUT_PATH} に {len(lines)} 路線を出力しました")


if __name__ == "__main__":
    main()
