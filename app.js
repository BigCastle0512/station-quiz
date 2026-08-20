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
let lineLabels = {}; // 路線名 -> Leaflet Marker(常時ラベル表示用)
let stationDots = {}; // 駅id -> Leaflet CircleMarker
const LINE_LABEL_MIN_ZOOM = 13; // これより引いた(数字が小さい)ズームではラベルを隠して文字の重なりを防ぐ

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
  updateMapHighlight();
  updateScoreText();
  nextQuestion();
}

function setupMap() {
  map = L.map("map").setView([35.68, 139.72], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 19,
  }).addTo(map);
  wardLayer = L.layerGroup().addTo(map);
  lineLayer = L.layerGroup().addTo(map);
  stationDotsLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("zoomend", updateLineLabelVisibility);
}

function renderWardBoundaries() {
  for (const [name, rings] of Object.entries(wardData)) {
    L.polygon(rings, {
      color: "#8a8a99",
      weight: 1.5,
      opacity: 0.8,
      fill: false,
      dashArray: "4 3",
      interactive: false,
    }).addTo(wardLayer);
  }
}

function renderLines() {
  for (const [name, entry] of Object.entries(lineData)) {
    const popupHtml = `<b>${name}</b><br>${entry.operator || ""}`;
    const polylines = entry.segments.map((seg) => {
      // タップ判定用に太い透明な線を下に重ね、見た目の細い線はそのまま保つ(スマホでの誤タップ対策)
      L.polyline(seg, { color: "#000", weight: 16, opacity: 0, interactive: true })
        .bindPopup(popupHtml)
        .addTo(lineLayer);
      return L.polyline(seg, { color: entry.color, weight: 3, opacity: 0.65 }).bindPopup(popupHtml).addTo(lineLayer);
    });
    linePolylines[name] = polylines;

    const longest = entry.segments.reduce((a, b) => (b.length > a.length ? b : a), entry.segments[0]);
    const midpoint = longest[Math.floor(longest.length / 2)];
    const label = L.marker(midpoint, {
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

function updateLineLabelVisibility() {
  const line = document.getElementById("line-filter").value;
  const operator = document.getElementById("operator-filter").value;
  const filterActive = Boolean(line || operator);
  const zoomOk = map.getZoom() >= LINE_LABEL_MIN_ZOOM;

  for (const [name, label] of Object.entries(lineLabels)) {
    const matches = (!line || name === line) && (!operator || lineData[name].operator === operator);
    const visible = zoomOk && (!filterActive || matches);
    const tooltip = label.getTooltip();
    const el = tooltip && tooltip.getElement();
    if (el) el.style.display = visible ? "" : "none";
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
      ? { opacity: 0.65, weight: 3 }
      : matches
      ? { opacity: 0.95, weight: 5 }
      : { opacity: 0.1, weight: 2 };
    polylines.forEach((pl) => pl.setStyle(style));
  }

  const dotActive = Boolean(line || operator || ward);
  for (const st of stations) {
    const dot = stationDots[st.id];
    if (!dot) continue;
    const matches =
      (!line || st.lines.includes(line)) &&
      (!operator || stationLinesForOperator(st, operator)) &&
      (!ward || st.ward === ward);
    dot.setStyle(!dotActive ? { opacity: 0.8, fillOpacity: 1, radius: 3 } : matches ? { opacity: 1, fillOpacity: 1, radius: 4 } : { opacity: 0.15, fillOpacity: 0.15, radius: 3 });
  }

  updateLineLabelVisibility();
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

  const onFilterChange = () => { applyFilters(); updateMapHighlight(); nextQuestion(); };
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

function startNameToPin() {
  const st = pickRandom(filteredStations);
  current = { type: "name-to-pin", station: st, answered: false };

  map.setView([35.68, 139.72], 11);
  document.getElementById("question-area").innerHTML = `「<b>${st.name}</b>」駅は地図上のどこ？<div class="sub">地図をクリックして回答</div>`;
  document.getElementById("answer-area").innerHTML = "";

  const clickHandler = (e) => {
    if (current.answered) return;
    current.answered = true;
    map.off("click", clickHandler);
    const dist = haversineKm(e.latlng.lat, e.latlng.lng, st.lat, st.lon);
    const correct = dist <= CORRECT_DISTANCE_KM;

    L.circleMarker([e.latlng.lat, e.latlng.lng], { radius: 7, color: "#999" }).addTo(markerLayer);
    L.circleMarker([st.lat, st.lon], { radius: 9, className: "station-marker" }).addTo(markerLayer);

    recordResult(st, correct);
    showFeedback(correct, correct ? "正解！" : `不正解。正しい位置との距離: 約${dist.toFixed(1)}km`);
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
