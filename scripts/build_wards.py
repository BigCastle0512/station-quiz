"""
東京23区の行政境界を取得し、data/wards.json (区名 -> [[[lat,lon],...], ...]) を生成する。

実行: python scripts/build_wards.py

各区のOSMリレーションIDはWikidata (P402) から取得したもの。Overpass APIは
行政境界のジオメトリ解決(out geom)が重く、公開インスタンスでは頻繁にタイムアウト
するため、区ごとに個別リクエスト+リトライで取得する。取得できなかった区は
data/stations.json の座標から凸包(convex hull)を計算し、簡易的な境界として代用する。

中間データ data/wards_raw/<relation_id>.json はキャッシュとして保存され、
再実行時は既に取得済みの区をスキップする。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
WARDS_RAW_DIR = DATA_DIR / "wards_raw"
STATIONS_PATH = DATA_DIR / "stations.json"
OUTPUT_PATH = DATA_DIR / "wards.json"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Wikidata (P402: OpenStreetMap relation ID) から取得した23区の行政境界リレーションID。
# 一部の区(荒川区・練馬区・江戸川区)はWikidataに登録が無く、Overpassの名前検索も
# 不安定だったため未確定。駅座標からの凸包で代用する。
WARD_RELATION_IDS = {
    "新宿区": 1758858, "港区": 1761717, "渋谷区": 1759477, "中央区": 1758897,
    "文京区": 1758878, "足立区": 1760124, "千代田区": 1761742, "江東区": 3554015,
    "大田区": 1758947, "世田谷区": 1759474, "葛飾区": 1761718, "杉並区": 1543055,
    "板橋区": 1760078, "台東区": 1758888, "品川区": 3554304, "目黒区": 1758936,
    "中野区": 1543056, "北区": 1760038, "墨田区": 1758891, "豊島区": 1759506,
}

ALL_WARDS = WARD_RELATION_IDS.keys() | {"荒川区", "練馬区", "江戸川区"}


def fetch_ward_geometry(relation_id: int) -> dict | None:
    query = f"[out:json][timeout:100];relation({relation_id});out geom;"
    data = urllib.parse.urlencode({"data": query}).encode()
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    endpoint, data=data,
                    headers={"User-Agent": "station-quiz-app/1.0 (personal study project)"},
                )
                with urllib.request.urlopen(req, timeout=120) as resp:
                    result = json.loads(resp.read())
                rel = next((e for e in result.get("elements", []) if e["type"] == "relation"), None)
                if rel and any(m.get("role") == "outer" and "geometry" in m for m in rel.get("members", [])):
                    return result
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                pass
            time.sleep(10)
    return None


def rings_from_relation_json(data: dict) -> list[list[list[float]]]:
    rel = next((e for e in data.get("elements", []) if e["type"] == "relation"), None)
    if not rel:
        return []
    rings = []
    for member in rel.get("members", []):
        if member.get("role") != "outer" or "geometry" not in member:
            continue
        ring = [[pt["lat"], pt["lon"]] for pt in member["geometry"]]
        if len(ring) >= 2:
            rings.append(ring)
    return rings


def convex_hull(points: list[tuple[float, float]]) -> list[list[float]]:
    points = sorted(set(points))
    if len(points) <= 2:
        return [list(p) for p in points]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(p) for p in (lower[:-1] + upper[:-1])]


def main():
    WARDS_RAW_DIR.mkdir(exist_ok=True)
    wards: dict[str, list] = {}

    for name, rel_id in WARD_RELATION_IDS.items():
        cache_path = WARDS_RAW_DIR / f"{rel_id}.json"
        if cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            rings = rings_from_relation_json(cached)
            if rings:
                wards[name] = rings
                print(f"  キャッシュから読み込み: {name}")
                continue
        print(f"  取得中: {name} ({rel_id})...")
        result = fetch_ward_geometry(rel_id)
        if result:
            cache_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            rings = rings_from_relation_json(result)
            if rings:
                wards[name] = rings
                print(f"    OK: {len(rings)}セグメント")
                continue
        print(f"    失敗、駅座標の凸包で代用します")

    missing = ALL_WARDS - wards.keys()
    if missing and STATIONS_PATH.exists():
        stations = json.loads(STATIONS_PATH.read_text(encoding="utf-8"))
        for ward in missing:
            pts = [(s["lat"], s["lon"]) for s in stations if s.get("ward") == ward]
            if len(pts) >= 3:
                wards[ward] = [convex_hull(pts)]
                print(f"  代用(駅座標の凸包): {ward} ({len(pts)}駅から生成)")
            else:
                print(f"  スキップ(データ不足): {ward}")

    OUTPUT_PATH.write_text(json.dumps(wards, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完了: {OUTPUT_PATH} に {len(wards)}/{len(ALL_WARDS)} 区を出力しました")


if __name__ == "__main__":
    main()
