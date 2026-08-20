const STORAGE_KEY = "station-quiz-progress-v1";
const CORRECT_DISTANCE_KM = 0.6; // 駅名→地図クリックで正解とみなす許容距離

let stations = [];
let lineData = {}; // 路線名 -> {color, operator, segments}
let wardData = {}; // 区名 -> [[[lat,lon],...], ...] (穴のあるポリゴンも考慮し複数リング)
let filteredStations = [];
let progress = loadProgress();
let mode = "pin-to-name";
let current = null; // 現在の問題に関する状態
let map, markerLayer, lineLayer, wardLayer, stationDotsLayer;
let linePolylines = {}; // 路線名 -> Leaflet Polyline[]
let lineCasings = {}; // 路線名 -> Leaflet Polyline[](縁取り)
let lineLabels = {}; // 路線名 -> Leaflet Marker(常時ラベル表示用)
let stationDots = {}; // 駅id -> Leaflet CircleMarker
let wardLabelScreenPoints = []; // 区名ラベルの画面座標(路線名ラベルが避けるために参照する)
const WARD_LABEL_AVOID_PX = 85; // 路線名ラベルが区名ラベルから離す最小距離
const LINE_LABEL_MIN_ZOOM = 13; // これより引いた(数字が小さい)ズームではラベルを隠して文字の重なりを防ぐ
const STATION_DOT_MIN_ZOOM = 13; // これより引いたズームでは駅の点を隠し、広域では路線の形状を見やすくする

let _measureCanvasCtx = null;
function measureTextWidth(text, font) {
  if (!_measureCanvasCtx) _measureCanvasCtx = document.createElement("canvas").getContext("2d");
  _measureCanvasCtx.font = font;
  return _measureCanvasCtx.measureText(text).width;
}

async function init() {
  const [stRes, lineRes] = await Promise.all([fetch("data/stations.json"), fetch("data/lines.json")]);
  stations = await stRes.json();
  lineData = await lineRes.json();
  try {
    const wardRes = await fetch("data/wards.json");
    if (wardRes.ok) wardData = await wardRes.json();
  } catch {
    wardData = {};
  }

  setupMap();
  renderWardBoundaries();
  renderLines();
  renderStationDots();
  setupFilters();
  setupModeButtons();
  document.getElementById("next-btn").addEventListener("click", nextQuestion);
  document.getElementById("reset-score-btn").addEventListener("click", resetScore);

  applyFilters();
  refreshMapOverlays();
  updateScoreText();
  nextQuestion();
}

function setupMap() {
  map = L.map("map").setView([35.68, 139.72], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 19,
  }).addTo(map);
  lineLayer = L.layerGroup().addTo(map);
  wardLayer = L.layerGroup().addTo(map);
  stationDotsLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("moveend", refreshMapOverlays);
}

function renderWardBoundaries() {
  // build_wards.py側で断片(弧)を閉じた1つのリングにつなげ済み
  for (const [name, rings] of Object.entries(wardData)) {
    L.polygon(rings, {
      color: "#7a5c4a",
      weight: 1.6,
      opacity: 0.55,
      fill: false,
      dashArray: "7 5",
      interactive: false,
    }).addTo(wardLayer);
  }
}

// レイキャスティング法による点内外判定 (ring は [lat,lon] の配列、閉じていなくても可)
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findWardAt(lat, lon) {
  for (const [name, rings] of Object.entries(wardData)) {
    if (rings.some((ring) => pointInRing(lat, lon, ring))) return name;
  }
  return null;
}

// 画面内をグリッド探索し、区の内側にありつつ境界や路線からできるだけ離れた点を返す。
// 最終候補でも画面上の境界からの余白(ラベルの実際の文字幅から算出)が足りなければ null を返し、無理に表示しない。
function findMostInteriorPoint(rings, bounds, center, requiredClearancePx, linePointSample) {
  const GRID = 14;
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  // 距離判定用に境界点を間引いてサンプリング(全点を使うと重いため)
  const boundarySample = [];
  for (const ring of rings) {
    const step = Math.max(1, Math.floor(ring.length / 60));
    for (let i = 0; i < ring.length; i += step) boundarySample.push(ring[i]);
  }
  if (boundarySample.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i <= GRID; i++) {
    const lat = south + ((north - south) * i) / GRID;
    for (let j = 0; j <= GRID; j++) {
      const lon = west + ((east - west) * j) / GRID;
      if (!rings.some((ring) => pointInRing(lat, lon, ring))) continue;

      let minDistSq = Infinity;
      for (const bp of boundarySample) {
        const dLat = lat - bp[0];
        const dLon = lon - bp[1];
        const distSq = dLat * dLat + dLon * dLon;
        if (distSq < minDistSq) minDistSq = distSq;
      }
      let minLineDistSq = Infinity;
      for (const lp of linePointSample) {
        const dLat = lat - lp[0];
        const dLon = lon - lp[1];
        const distSq = dLat * dLat + dLon * dLon;
        if (distSq < minLineDistSq) minLineDistSq = distSq;
      }
      const centerPenalty = ((lat - center.lat) ** 2 + (lon - center.lng) ** 2) * 0.05;
      // 境界からの距離を最優先しつつ、路線からもできるだけ離れた点を選ぶ(路線側は補助的な重み)
      const score = minDistSq + Math.min(minLineDistSq, minDistSq) * 0.5 - centerPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = [lat, lon];
      }
    }
  }
  if (!best) return null;

  // 選んだ点が画面上で本当に境界から十分離れているか、ラベルの実際の幅を踏まえて最終確認する
  const bestScreen = map.latLngToContainerPoint(best);
  let minPixelDist = Infinity;
  for (const bp of boundarySample) {
    const d = bestScreen.distanceTo(map.latLngToContainerPoint(bp));
    if (d < minPixelDist) minPixelDist = d;
  }
  return minPixelDist >= requiredClearancePx ? best : null;
}

let wardLabels = {}; // 区名 -> Leaflet Marker(常時ラベル表示用)
const WARD_LABEL_MIN_ZOOM = 10;

function updateWardLabelPositions() {
  for (const label of Object.values(wardLabels)) map.removeLayer(label);
  wardLabels = {};

  if (map.getZoom() < WARD_LABEL_MIN_ZOOM) return;

  const bounds = map.getBounds();
  const center = map.getCenter();
  const MIN_LABEL_SPACING_PX = 90;
  const MIN_VISIBLE_EXTENT_PX = 70; // 画面内に見えている範囲がこれより小さい区は表示しない
  const size = map.getSize();
  const edgeMargin = Math.min(70, size.x / 4, size.y / 4); // ラベルが画面端で見切れないよう、探索範囲を画面より一回り内側に絞る
  const insetBounds = L.latLngBounds(
    map.containerPointToLatLng([edgeMargin, size.y - edgeMargin]),
    map.containerPointToLatLng([size.x - edgeMargin, edgeMargin])
  );
  const WARD_LABEL_FONT = "700 1.5rem sans-serif";

  // 路線ともなるべく重ならないよう、画面内に見えている路線の座標を間引いてサンプリングしておく
  const linePointSample = [];
  for (const entry of Object.values(lineData)) {
    for (const seg of entry.segments) {
      const step = Math.max(1, Math.floor(seg.length / 20));
      for (let i = 0; i < seg.length; i += step) {
        if (bounds.contains(seg[i])) linePointSample.push(seg[i]);
      }
    }
  }

  const candidates = [];

  for (const [name, rings] of Object.entries(wardData)) {
    const centerInside = rings.some((ring) => pointInRing(center.lat, center.lng, ring));

    // 画面内に入っている境界点を集め、見えている範囲の大きさを判定する(高コストな探索を省くための事前フィルタ)
    const inViewPoints = [];
    for (const ring of rings) {
      for (const pt of ring) {
        if (bounds.contains(pt)) inViewPoints.push(pt);
      }
    }
    if (!centerInside && inViewPoints.length === 0) continue;

    if (inViewPoints.length > 0) {
      const screenPts = inViewPoints.map((pt) => map.latLngToContainerPoint(pt));
      const xs = screenPts.map((p) => p.x);
      const ys = screenPts.map((p) => p.y);
      const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (!centerInside && extent < MIN_VISIBLE_EXTENT_PX) continue; // 見えている範囲が小さすぎる区は表示しない
    }

    // 境界・路線からできるだけ離れた区の内側の点を探す。実際の文字幅の半分+余白を
    // 必要な余白として使い、画面上でそれを満たせない場合は null を返して無理に表示しない。
    const requiredClearancePx = measureTextWidth(name, WARD_LABEL_FONT) / 2 + 14;
    const point = findMostInteriorPoint(rings, insetBounds, center, requiredClearancePx, linePointSample);
    if (!point) continue;
    candidates.push({ name, point });
  }

  const placedScreenPoints = [];
  for (const { name, point } of candidates) {
    const screenPt = map.latLngToContainerPoint(point);
    if (placedScreenPoints.some((p) => screenPt.distanceTo(p) < MIN_LABEL_SPACING_PX)) continue;
    placedScreenPoints.push(screenPt);

    const label = L.marker(point, {
      icon: L.divIcon({ className: "ward-label-anchor", iconSize: [0, 0] }),
      interactive: false,
      keyboard: false,
    })
      .bindTooltip(name, { permanent: true, direction: "center", className: "ward-label" })
      .addTo(wardLayer);
    wardLabels[name] = label;
  }
  wardLabelScreenPoints = placedScreenPoints;
}

function renderLines() {
  for (const [name, entry] of Object.entries(lineData)) {
    const popupHtml = `<b>${name}</b><br>${entry.operator || ""}`;
    const casings = [];
    const polylines = entry.segments.map((seg) => {
      // 縁取り: 黄色など淡い色の路線が薄い背景地図に埋もれて見えなくなるのを防ぐ(太すぎないよう最小限に)
      casings.push(L.polyline(seg, { color: "#222", weight: 3.5, opacity: 0.2, interactive: false }).addTo(lineLayer));
      // タップ判定用に太い透明な線を下に重ね、見た目の細い線はそのまま保つ(スマホでの誤タップ対策)
      L.polyline(seg, { color: "#000", weight: 16, opacity: 0, interactive: true })
        .bindPopup(popupHtml)
        .addTo(lineLayer);
      return L.polyline(seg, { color: entry.color, weight: 2, opacity: 0.85 }).bindPopup(popupHtml).addTo(lineLayer);
    });
    linePolylines[name] = polylines;
    lineCasings[name] = casings;
  }
}

function updateLineLabelPositions() {
  const line = document.getElementById("line-filter").value;
  const operator = document.getElementById("operator-filter").value;
  const filterActive = Boolean(line || operator);
  const zoomOk = map.getZoom() >= LINE_LABEL_MIN_ZOOM;

  for (const [name, label] of Object.entries(lineLabels)) {
    map.removeLayer(label);
  }
  lineLabels = {};

  if (!zoomOk) return;

  const bounds = map.getBounds();
  const center = map.getCenter();
  const MIN_LABEL_SPACING_PX = 60; // ラベル同士の重なりを避けるための最小画面距離

  const candidates = [];
  for (const [name, entry] of Object.entries(lineData)) {
    const matches = (!line || name === line) && (!operator || entry.operator === operator);
    if (filterActive && !matches) continue;

    let best = null;
    let bestDist = Infinity;
    for (const seg of entry.segments) {
      for (const pt of seg) {
        if (!bounds.contains(pt)) continue;
        const d = center.distanceTo(pt);
        if (d < bestDist) {
          bestDist = d;
          best = pt;
        }
      }
    }
    if (best) candidates.push({ name, entry, point: best, dist: bestDist });
  }

  // 画面中心に近い(=より目立つ)路線を優先して配置し、既存ラベルや区名ラベルと近すぎる候補はスキップする
  candidates.sort((a, b) => a.dist - b.dist);
  const placedScreenPoints = [];

  for (const { name, entry, point } of candidates) {
    const screenPt = map.latLngToContainerPoint(point);
    const tooCloseToLine = placedScreenPoints.some((p) => screenPt.distanceTo(p) < MIN_LABEL_SPACING_PX);
    const tooCloseToWard = wardLabelScreenPoints.some((p) => screenPt.distanceTo(p) < WARD_LABEL_AVOID_PX);
    if (tooCloseToLine || tooCloseToWard) continue;
    placedScreenPoints.push(screenPt);

    const label = L.marker(point, {
      icon: L.divIcon({ className: "line-label-anchor", iconSize: [0, 0] }),
      interactive: false,
      keyboard: false,
    })
      .bindTooltip(`<span class="line-label-swatch" style="background:${entry.color}"></span>${name}`, {
        permanent: true,
        direction: "center",
        className: "line-label",
      })
      .addTo(lineLayer);
    lineLabels[name] = label;
  }
}

function renderStationDots() {
  for (const st of stations) {
    const dot = L.circleMarker([st.lat, st.lon], {
      radius: 3,
      color: "#333",
      weight: 1,
      fillColor: "#fff",
      fillOpacity: 1,
      opacity: 0.8,
    }).bindPopup(`<b>${st.name}</b><br>${st.ward || ""}`).addTo(stationDotsLayer);
    stationDots[st.id] = dot;
  }
}

function updateMapHighlight() {
  const line = document.getElementById("line-filter").value;
  const operator = document.getElementById("operator-filter").value;
  const ward = document.getElementById("ward-filter").value;
  const lineActive = Boolean(line || operator);

  for (const [name, polylines] of Object.entries(linePolylines)) {
    const matches = (!line || name === line) && (!operator || lineData[name].operator === operator);
    const style = !lineActive
      ? { opacity: 0.85, weight: 2 }
      : matches
      ? { opacity: 1, weight: 3.5 }
      : { opacity: 0, weight: 2 };
    const casingStyle = !lineActive
      ? { opacity: 0.2, weight: 3.5 }
      : matches
      ? { opacity: 0.3, weight: 5 }
      : { opacity: 0, weight: 3.5 };
    polylines.forEach((pl) => pl.setStyle(style));
    (lineCasings[name] || []).forEach((pl) => pl.setStyle(casingStyle));
  }

  const dotActive = Boolean(line || operator || ward);
  const dotZoomOk = map.getZoom() >= STATION_DOT_MIN_ZOOM;
  for (const st of stations) {
    const dot = stationDots[st.id];
    if (!dot) continue;
    if (!dotZoomOk) {
      dot.setStyle({ opacity: 0, fillOpacity: 0 });
      continue;
    }
    const matches =
      (!line || st.lines.includes(line)) &&
      (!operator || stationLinesForOperator(st, operator)) &&
      (!ward || st.ward === ward);
    dot.setStyle(!dotActive ? { opacity: 0.8, fillOpacity: 1, radius: 3 } : matches ? { opacity: 1, fillOpacity: 1, radius: 4 } : { opacity: 0.15, fillOpacity: 0.15, radius: 3 });
  }
}

// 区名ラベル(大きく場所を占める)を先に確定させてから路線名ラベルがそれを避けるようにする
function refreshMapOverlays() {
  updateWardLabelPositions();
  updateMapHighlight();
  updateLineLabelPositions();
}

function setupFilters() {
  const lineSet = new Set();
  const wardSet = new Set();
  const operatorSet = new Set();
  for (const st of stations) {
    st.lines.forEach((l) => lineSet.add(l));
    if (st.ward) wardSet.add(st.ward);
  }
  for (const entry of Object.values(lineData)) {
    if (entry.operator) operatorSet.add(entry.operator);
  }

  const operatorSelect = document.getElementById("operator-filter");
  [...operatorSet].sort().forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    operatorSelect.appendChild(opt);
  });

  const lineSelect = document.getElementById("line-filter");
  [...lineSet].sort().forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    lineSelect.appendChild(opt);
  });
  const wardSelect = document.getElementById("ward-filter");
  [...wardSet].sort().forEach((w) => {
    const opt = document.createElement("option");
    opt.value = w;
    opt.textContent = w;
    wardSelect.appendChild(opt);
  });

  const onFilterChange = () => { applyFilters(); refreshMapOverlays(); nextQuestion(); };
  operatorSelect.addEventListener("change", onFilterChange);
  lineSelect.addEventListener("change", onFilterChange);
  wardSelect.addEventListener("change", onFilterChange);
  document.getElementById("weak-only-checkbox").addEventListener("change", onFilterChange);
}

function stationLinesForOperator(st, operator) {
  return st.lines.some((l) => lineData[l]?.operator === operator);
}

function applyFilters() {
  const line = document.getElementById("line-filter").value;
  const operator = document.getElementById("operator-filter").value;
  const ward = document.getElementById("ward-filter").value;
  const weakOnly = document.getElementById("weak-only-checkbox").checked;

  const baseFilter = (st) => {
    if (line && !st.lines.includes(line)) return false;
    if (operator && !stationLinesForOperator(st, operator)) return false;
    if (ward && st.ward !== ward) return false;
    return true;
  };

  filteredStations = stations.filter((st) => baseFilter(st) && (!weakOnly || isWeak(st)));

  if (filteredStations.length < 4) {
    filteredStations = stations.filter(baseFilter);
  }
}

function isWeak(st) {
  const rec = progress[st.id];
  return rec && rec.correct < rec.wrong;
}

function setupModeButtons() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      mode = btn.dataset.mode;
      nextQuestion();
    });
  });
}

function pickRandom(arr, exclude) {
  let choice;
  do {
    choice = arr[Math.floor(Math.random() * arr.length)];
  } while (arr.length > 1 && choice === exclude);
  return choice;
}

function pickChoices(correct, n) {
  const pool = filteredStations.filter((s) => s !== correct);
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, n - 1);
  const choices = [...shuffled, correct];
  return choices.sort(() => Math.random() - 0.5);
}

function nextQuestion() {
  document.getElementById("next-btn").style.display = "none";
  document.getElementById("feedback-area").textContent = "";
  document.getElementById("feedback-area").className = "";
  markerLayer.clearLayers();
  setOverlaysInteractive(true); // モード切替などで前の問題のクリック無効化が残らないようにする

  if (filteredStations.length === 0) {
    document.getElementById("question-area").textContent = "この条件に一致する駅がありません。フィルタを変更してください。";
    document.getElementById("answer-area").innerHTML = "";
    return;
  }

  if (mode === "pin-to-name") startPinToName();
  else if (mode === "name-to-pin") startNameToPin();
  else startKnowledge();
}

function startPinToName() {
  const st = pickRandom(filteredStations);
  const choices = pickChoices(st, 4);
  current = { type: "pin-to-name", station: st, choices };

  map.setView([st.lat, st.lon], 15);
  L.circleMarker([st.lat, st.lon], { radius: 9, className: "station-marker" }).addTo(markerLayer);

  document.getElementById("question-area").innerHTML = "地図のピンの駅名は？";
  const answerArea = document.getElementById("answer-area");
  answerArea.innerHTML = "";
  choices.forEach((choice) => {
    const btn = document.createElement("button");
    btn.className = "choice";
    btn.textContent = choice.name;
    btn.addEventListener("click", () => handleChoiceAnswer(btn, choice, st));
    answerArea.appendChild(btn);
  });
}

function choiceLabelHtml(choice) {
  const lines = choice.lines
    .map((l) => `<span class="reveal-line-chip"><span class="line-label-swatch" style="background:${lineData[l]?.color || "#999"}"></span>${l}</span>`)
    .join("");
  return `<b>${choice.name}</b>${lines ? `<div class="reveal-lines">${lines}</div>` : ""}`;
}

function revealChoiceLocations(correctStation, chosenStation) {
  const bounds = [];
  for (const choice of current.choices) {
    bounds.push([choice.lat, choice.lon]);
    const html = choiceLabelHtml(choice);
    if (choice === correctStation) {
      L.circleMarker([choice.lat, choice.lon], { radius: 9, className: "station-marker" })
        .bindTooltip(html, { permanent: true, direction: "top", className: "reveal-label correct" })
        .addTo(markerLayer);
      continue;
    }
    const isWrongPick = choice === chosenStation;
    L.circleMarker([choice.lat, choice.lon], {
      radius: 7,
      color: isWrongPick ? "#d9463f" : "#999",
      fillColor: isWrongPick ? "#d9463f" : "#999",
      fillOpacity: 0.8,
      weight: 2,
    })
      .bindTooltip(html, { permanent: true, direction: "top", className: isWrongPick ? "reveal-label wrong" : "reveal-label" })
      .addTo(markerLayer);
  }
  map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
}

function setOverlaysInteractive(enabled) {
  for (const layerGroup of [lineLayer, stationDotsLayer]) {
    layerGroup.eachLayer((layer) => {
      const el = layer.getElement && layer.getElement();
      if (el) el.style.pointerEvents = enabled ? "" : "none";
    });
  }
}

function startNameToPin() {
  const st = pickRandom(filteredStations);
  current = { type: "name-to-pin", station: st, answered: false };

  map.setView([35.68, 139.72], 11);
  document.getElementById("question-area").innerHTML =
    `「<b>${st.name}</b>」駅は地図上のどこ？<div class="sub">地図をクリックして回答(${CORRECT_DISTANCE_KM}km以内なら正解)</div>`;
  document.getElementById("answer-area").innerHTML = "";

  // クイズ中は路線のポップアップが地図クリックを奪わないよう無効化する
  setOverlaysInteractive(false);

  const clickHandler = (e) => {
    if (current.answered) return;
    current.answered = true;
    map.off("click", clickHandler);
    setOverlaysInteractive(true);
    const dist = haversineKm(e.latlng.lat, e.latlng.lng, st.lat, st.lon);
    const correct = dist <= CORRECT_DISTANCE_KM;

    L.circle([st.lat, st.lon], {
      radius: CORRECT_DISTANCE_KM * 1000,
      color: "#2563eb",
      weight: 1,
      fillOpacity: 0.07,
      interactive: false,
    }).addTo(markerLayer);
    L.circleMarker([e.latlng.lat, e.latlng.lng], { radius: 7, color: "#999" }).addTo(markerLayer);
    L.circleMarker([st.lat, st.lon], { radius: 9, className: "station-marker" }).addTo(markerLayer);

    recordResult(st, correct);
    showFeedback(
      correct,
      correct
        ? `正解！(実際の位置まで約${dist.toFixed(2)}km)`
        : `不正解。実際の位置までの距離: 約${dist.toFixed(2)}km(${CORRECT_DISTANCE_KM}km以内なら正解でした。青い円が正解の範囲です)`
    );
  };
  map.on("click", clickHandler);
}

function startKnowledge() {
  const eligible = filteredStations.filter((s) => s.lines.length > 0);
  const pool = eligible.length >= 4 ? eligible : filteredStations;
  const st = pickRandom(pool);
  current = { type: "knowledge", station: st };

  map.setView([st.lat, st.lon], 14);
  L.circleMarker([st.lat, st.lon], { radius: 9, className: "station-marker" }).addTo(markerLayer);

  const qType = pickKnowledgeQuestionType(st);
  const answerArea = document.getElementById("answer-area");
  answerArea.innerHTML = "";

  if (qType === "line") {
    document.getElementById("question-area").innerHTML = `<b>${st.name}</b>駅を通る路線はどれ？`;
    const correctLine = st.lines[Math.floor(Math.random() * st.lines.length)];
    const otherLines = [...new Set(stations.flatMap((s) => s.lines))].filter((l) => !st.lines.includes(l));
    const wrongChoices = shuffle(otherLines).slice(0, 3);
    const choices = shuffle([correctLine, ...wrongChoices]);
    choices.forEach((line) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.textContent = line;
      btn.addEventListener("click", () => handleTextChoiceAnswer(btn, line, correctLine));
      answerArea.appendChild(btn);
    });
  } else if (qType === "ward") {
    document.getElementById("question-area").innerHTML = `<b>${st.name}</b>駅は何区にある？`;
    const otherWards = [...new Set(stations.map((s) => s.ward).filter((w) => w && w !== st.ward))];
    const wrongChoices = shuffle(otherWards).slice(0, 3);
    const choices = shuffle([st.ward, ...wrongChoices]);
    choices.forEach((ward) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.textContent = ward;
      btn.addEventListener("click", () => handleTextChoiceAnswer(btn, ward, st.ward));
      answerArea.appendChild(btn);
    });
  } else if (qType === "adjacent") {
    const line = Object.keys(st.adjacent)[0];
    const correctNeighbor = st.adjacent[line][0];
    document.getElementById("question-area").innerHTML = `<b>${st.name}</b>駅(${line})の隣の駅はどれ？`;
    const otherStations = shuffle(stations.map((s) => s.name).filter((n) => n !== st.name && n !== correctNeighbor)).slice(0, 3);
    const choices = shuffle([correctNeighbor, ...otherStations]);
    choices.forEach((name) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.textContent = name;
      btn.addEventListener("click", () => handleTextChoiceAnswer(btn, name, correctNeighbor));
      answerArea.appendChild(btn);
    });
  } else {
    const term = pickRandom(["新宿", "東京", "渋谷"]);
    const otherSt = pickRandom(filteredStations, st);
    document.getElementById("question-area").innerHTML = `${term}駅から近いのはどっち？(直線距離)`;
    [st, otherSt].forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.textContent = s.name;
      btn.addEventListener("click", () => {
        const winner = st.distance_km[term] <= otherSt.distance_km[term] ? st : otherSt;
        handleTextChoiceAnswer(btn, s.name, winner.name, `${st.name}: ${st.distance_km[term]}km / ${otherSt.name}: ${otherSt.distance_km[term]}km`);
      });
      answerArea.appendChild(btn);
    });
  }
}

function pickKnowledgeQuestionType(st) {
  const options = [];
  if (st.lines.length > 0) options.push("line");
  if (st.ward) options.push("ward");
  if (Object.keys(st.adjacent).length > 0) options.push("adjacent");
  options.push("distance");
  return options[Math.floor(Math.random() * options.length)];
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function handleChoiceAnswer(btn, choice, correctStation) {
  if (current.answered) return;
  current.answered = true;
  const correct = choice === correctStation;
  markChoiceButtons(correct, choice.name, correctStation.name);
  recordResult(correctStation, correct);
  const lineInfo = correctStation.lines.length ? `(${correctStation.lines.join("・")})` : "";
  const message = correct
    ? `正解！「${correctStation.name}」${lineInfo}`
    : `不正解。正解は「${correctStation.name}」${lineInfo}`;
  showFeedback(correct, message);
  revealChoiceLocations(correctStation, choice);
}

function handleTextChoiceAnswer(btn, chosenValue, correctValue, extraNote) {
  if (current.answered) return;
  current.answered = true;
  const correct = chosenValue === correctValue;
  markChoiceButtons(correct, chosenValue, correctValue);
  recordResult(current.station, correct);
  let msg = correct ? "正解！" : `不正解。正解は「${correctValue}」`;
  if (extraNote) msg += ` (${extraNote})`;
  showFeedback(correct, msg);
}

function markChoiceButtons(correct, chosenLabel, correctLabel) {
  document.querySelectorAll("#answer-area button.choice").forEach((b) => {
    b.disabled = true;
    if (b.textContent === correctLabel) b.classList.add("correct");
    else if (b.textContent === chosenLabel && !correct) b.classList.add("wrong");
  });
}

function showFeedback(correct, message) {
  const el = document.getElementById("feedback-area");
  el.textContent = message;
  el.className = correct ? "correct" : "wrong";
  document.getElementById("next-btn").style.display = "block";
}

function recordResult(station, correct) {
  const rec = progress[station.id] || { correct: 0, wrong: 0 };
  if (correct) rec.correct++; else rec.wrong++;
  progress[station.id] = rec;
  saveProgress();
  updateScoreText();
}

function updateScoreText() {
  const totals = Object.values(progress).reduce(
    (acc, r) => ({ correct: acc.correct + r.correct, total: acc.total + r.correct + r.wrong }),
    { correct: 0, total: 0 }
  );
  document.getElementById("score-text").textContent = `${totals.correct} / ${totals.total}`;
}

function resetScore() {
  if (!confirm("スコアと苦手駅の記録をリセットしますか？")) return;
  progress = {};
  saveProgress();
  updateScoreText();
}

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlambda / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

init();
