# 東京23区 駅名クイズ

地図上のピンや路線図から東京23区の駅名を当てる学習用クイズアプリ。

- 地図→駅名 / 駅名→地図クリック / 知識クイズ(路線・区・隣の駅・主要ターミナルまでの距離)の3モード
- 路線ごとの色分け表示(OpenStreetMapデータの路線色)
- 会社・路線・区で出題範囲を絞り込み可能
- 正誤はブラウザのlocalStorageに保存

## 使い方

```bash
python -m http.server 8765
```

を実行して `http://localhost:8765` を開く。

## データの再生成

`data/stations.json` と `data/lines.json` は OpenStreetMap (Overpass API) と Nominatim から生成しています。

```bash
python scripts/build_stations.py
```
