// app.js — screen logic for Weekend Trips. All the thinking lives in core.js.
(function () {
  const C = Core;
  const ALL_PLACES = typeof PLACES === "undefined" ? [] : PLACES;
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const ua = navigator.userAgent;
  const platform = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1)
    ? "ios" : /Android/.test(ua) ? "android" : "desktop";

  let settings = Object.assign({}, C.DEFAULTS, store.get("settings") || {}, { weekOffset: 0 });
  let weather = null;       // { fetchedAt, json, offline? }
  let drives = {};          // { placeId: minutes } from the current home
  let activeDay = null;     // day key
  const KIND_ICON = { morning: "☀️", sunrise: "🌅", evening: "🌤️", sunset: "🌇" };
  const HIGHLIGHT = { waterfall: "💧 Waterfall", view: "⛰️ View", both: "💧⛰️ Waterfall + view" };
  const SHADE = { shaded: "🌳 Shaded", partial: "🌤 Some shade", exposed: "☀️ Little shade" };

  const saveSettings = () => { const { weekOffset, ...keep } = settings; store.set("settings", keep); };
  const originKey = (o) => o ? `${o.lat},${o.lon}` : "";
  function setStatus(text) { $("#status").textContent = text; }

  // ---------- data loading ----------

  async function loadWeather(force) {
    const cached = store.get("weather");
    const fresh = cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000;
    if (cached && fresh && !force) { weather = cached; return; }
    $("#refresh").classList.add("spin");
    try {
      const res = await fetch(C.weatherUrl(ALL_PLACES));
      if (!res.ok) throw new Error("HTTP " + res.status);
      weather = { fetchedAt: Date.now(), json: await res.json() };
      store.set("weather", weather);
    } catch (e) {
      weather = cached || null;
      if (weather) weather.offline = true;
    } finally {
      $("#refresh").classList.remove("spin");
    }
  }

  // Drive times change only when home or the places list changes, so keep them for 30 days.
  async function loadDrives(force) {
    const o = settings.origin;
    if (!o) { drives = {}; return; }
    const cached = store.get("drives");
    const sig = `${originKey(o)}|${ALL_PLACES.length}`;
    if (cached && cached.sig === sig && !force && Date.now() - cached.at < 30 * 864e5) { drives = cached.map; return; }
    try {
      const res = await fetch(C.drivesUrl(o, ALL_PLACES));
      const map = C.parseDrives(await res.json(), ALL_PLACES);
      if (!Object.keys(map).length) throw new Error("no routes");
      drives = map;
      store.set("drives", { sig, at: Date.now(), map });
    } catch (e) {
      drives = cached && cached.sig === sig ? cached.map : {};   // fall back to estimates
    }
  }

  // ---------- rendering ----------

  function render() {
    const now = new Date();
    const o = settings.origin;
    $("#origin-label").textContent = o ? `From ${o.name}` : "Set your home";

    if (!o) {
      setStatus("Tell the app where you live to get started.");
      $("#day-tabs").innerHTML = "";
      $("#list").innerHTML = `<div class="empty"><p>Drive times and prayer times are worked out from your home.</p>
        <button class="btn primary" id="empty-home">Set your home</button></div>`;
      $("#empty-home").onclick = openHome;
      $("#dropped").hidden = true;
      return;
    }

    const days = C.weekendDays(now, settings.weekOffset);
    if (!activeDay || !days.find((d) => d.key === activeDay)) {
      const today = C.sydneyParts(now);
      const todayKey = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
      activeDay = (days.find((d) => d.key >= todayKey) || days[0]).key;
    }

    if (!weather) setStatus("Couldn't load the forecast. Check your connection.");
    else setStatus(`${weather.offline ? "Offline. Forecast from" : "Forecast updated"} ${C.fmtTime(new Date(weather.fetchedAt))}`);

    const places = C.withDrives(ALL_PLACES, o, drives);
    const wmap = weather ? C.parseWeather(weather.json, ALL_PLACES) : {};
    const trips = C.planTrips(places, wmap, days, settings, now);

    const tabs = $("#day-tabs");
    tabs.innerHTML = "";
    for (const d of days) {
      const best = C.bestForDay(trips, d.key, 1)[0];
      const b = document.createElement("button");
      b.className = d.key === activeDay ? "on" : "";
      b.innerHTML = `<strong>${C.fmtDay(d)}</strong>`;
      b.append(best ? `${KIND_ICON[best.kind]} ${best.place.name}` : "No good options");
      b.onclick = () => { activeDay = d.key; render(); };
      tabs.appendChild(b);
    }

    const list = $("#list");
    list.innerHTML = "";
    if (weather && weather.offline) {
      list.insertAdjacentHTML("beforeend", `<div class="banner">You're offline, so this is the last forecast saved on this phone.</div>`);
    }
    const reachable = places.filter((p) => p.driveMins <= settings.maxDrive).length;
    const best = C.bestForDay(trips, activeDay, 8);
    if (!reachable) {
      list.insertAdjacentHTML("beforeend", `<p class="empty">None of the places in the app are within ${settings.maxDrive} minutes of ${o.name} yet. The list currently covers the Sydney region.</p>`);
    } else if (!best.length) {
      list.insertAdjacentHTML("beforeend", `<p class="empty">No trips fit your rules this day. It may be too hot, too wet, or already too late. Try the other day or next weekend.</p>`);
    }
    best.forEach((t, i) => list.appendChild(card(t, i === 0)));

    const shown = new Set(best.map((t) => t.place.id));
    const why = {};
    for (const t of trips) {
      if (t.day.key !== activeDay || shown.has(t.place.id) || t.score !== null) continue;
      (why[t.place.name] = why[t.place.name] || new Set()).add(`${C.KIND_LABEL[t.kind]}: ${t.reasons[0]}`);
    }
    const dl = $("#dropped-list");
    dl.innerHTML = "";
    Object.keys(why).sort().forEach((name) => {
      const li = document.createElement("li");
      li.textContent = `${name} · ${[...why[name]].join(" · ")}`;
      dl.appendChild(li);
    });
    $("#dropped").hidden = !Object.keys(why).length;
  }

  function card(t, isTop) {
    const el = $("#card-tpl").content.firstElementChild.cloneNode(true);
    if (isTop) el.classList.add("top-pick");
    el.classList.add(`k-${t.kind}`);
    const kind = el.querySelector(".kind");
    kind.textContent = `${KIND_ICON[t.kind]} ${isTop ? "Top pick · " : ""}${C.KIND_LABEL[t.kind]}`;
    el.querySelector(".score").textContent = `${t.score} pts`;
    el.querySelector(".name").textContent = t.place.name;
    el.querySelector(".area").textContent = `${t.place.area} · ${t.place.walk}`;

    const m = t.place.mins;
    const hrs = m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}` : `${m} min`;
    const facts = [
      HIGHLIGHT[t.place.highlight], `🚗 ${t.place.driveMins} min${t.place.driveApprox ? " (est.)" : ""}`,
      `🥾 ${t.place.km} km · ${hrs}`, `Grade ${t.place.grade}`, SHADE[t.place.shade],
      t.place.toilets ? "🚻 Toilets" : "No toilets",
    ];
    const ul = el.querySelector(".facts");
    facts.forEach((f) => { const li = document.createElement("li"); li.textContent = f; ul.appendChild(li); });

    const w = t.weather;
    const lo = Math.round(w.feelsMin), hi = Math.round(w.feelsMax);
    el.querySelector(".temp b").textContent = `${hi}°`;
    el.querySelector(".temp span").textContent = w.icon;
    el.querySelector(".wx").textContent = `${w.text} · feels ${lo === hi ? hi : lo + "–" + hi}° · rain ${w.rainMax ?? 0}%${w.uvMax >= 6 ? ` · UV ${Math.round(w.uvMax)}` : ""}`;

    const steps = [["Leave home", t.leaveHome],
      [t.watch ? (t.kind === "sunrise" ? "Sunrise" : "Sunset") : "Start walk", t.watch || t.startWalk],
      ["Back at car", t.endWalk], ["Home", t.homeAt]];
    const ol = el.querySelector(".timeline");
    steps.forEach(([label, time]) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${label}</span><b>${C.fmtTime(time)}</b>`;
      ol.appendChild(li);
    });

    const rs = el.querySelector(".reasons");
    t.reasons.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      if (/rain \(|^Warm$|UV|Dry|Fog/.test(r)) li.className = "minus";
      rs.appendChild(li);
    });
    const pr = el.querySelector(".prayer");
    t.notes.forEach((n) => { const li = document.createElement("li"); li.textContent = n; pr.appendChild(li); });

    const links = C.mapsLinks(t.place, platform);
    el.querySelector(".directions").href = links.primary;
    el.querySelector(".directions").textContent = platform === "ios" ? "Directions in Maps" : "Directions";
    el.querySelector(".gmaps").href = links.google;
    if (platform === "desktop") el.querySelector(".gmaps").remove();
    el.querySelector(".alerts").href = t.place.alertsUrl;
    return el;
  }

  // ---------- home picker ----------

  const homeDlg = $("#home-dlg");
  const homeForm = $("#home-form");
  const results = $("#home-results");
  let searchTimer = null;

  function openHome() {
    homeForm.elements.q.value = "";
    results.innerHTML = "";
    $("#home-cancel").hidden = !settings.origin;   // first run: must choose
    if ($("#settings").open) $("#settings").close("cancel");
    homeDlg.showModal();
    homeForm.elements.q.focus();
  }
  homeDlg.addEventListener("cancel", (e) => { if (!settings.origin) e.preventDefault(); });

  homeForm.elements.q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = homeForm.elements.q.value;
    if (q.trim().length < 3) { results.innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      results.innerHTML = `<li class="msg">Searching…</li>`;
      try {
        const res = await fetch(C.geocodeUrl(q));
        const found = C.parseGeocode(await res.json());
        results.innerHTML = found.length ? "" : `<li class="msg">No match. Try the suburb name only.</li>`;
        found.forEach((r) => {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          b.innerHTML = `<b></b><small></small>`;
          b.querySelector("b").textContent = r.name;
          b.querySelector("small").textContent = r.region;
          b.onclick = () => chooseHome(r);
          li.appendChild(b);
          results.appendChild(li);
        });
      } catch (e) {
        results.innerHTML = `<li class="msg">Couldn't search. Check your connection.</li>`;
      }
    }, 350);
  });
  homeForm.addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();   // Enter in the search box shouldn't close the dialog
  });

  async function chooseHome(r) {
    settings.origin = { name: r.name, lat: r.lat, lon: r.lon };
    saveSettings();
    homeDlg.close();
    setStatus("Working out drive times…");
    await loadDrives(true);
    if (!weather) await loadWeather(false);
    render();
  }
  $("#origin-label").onclick = openHome;
  $("#change-home").onclick = openHome;

  // ---------- week toggle ----------

  $("#week-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    settings.weekOffset = +b.dataset.week;
    activeDay = null;
    document.querySelectorAll("#week-seg button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });

  // ---------- settings ----------

  const dlg = $("#settings");
  const form = $("#settings-form");
  const methodSel = form.elements.method;
  for (const k in C.METHODS) methodSel.add(new Option(C.METHODS[k].label, k));
  const syncOut = () => {
    $("#maxDrive-out").textContent = form.elements.maxDrive.value;
    $("#maxSunriseDrive-out").textContent = form.elements.maxSunriseDrive.value;
    $("#maxFeels-out").textContent = form.elements.maxFeels.value;
  };
  form.addEventListener("input", syncOut);
  $("#open-settings").onclick = () => {
    $("#settings-home").textContent = settings.origin ? settings.origin.name : "Not set";
    form.elements.homeBy.value = settings.homeBy;
    form.elements.maxDrive.value = settings.maxDrive;
    form.elements.maxSunriseDrive.value = settings.maxSunriseDrive;
    form.elements.maxFeels.value = settings.maxFeels;
    form.elements.asrFactor.value = String(settings.asrFactor);
    methodSel.value = settings.method;
    syncOut();
    dlg.showModal();
  };
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    settings.homeBy = form.elements.homeBy.value || C.DEFAULTS.homeBy;
    settings.maxDrive = +form.elements.maxDrive.value;
    settings.maxSunriseDrive = +form.elements.maxSunriseDrive.value;
    settings.maxFeels = +form.elements.maxFeels.value;
    settings.asrFactor = +form.elements.asrFactor.value;
    settings.method = methodSel.value;
    saveSettings();
    render();
  });

  $("#refresh").onclick = async () => { await Promise.all([loadWeather(true), loadDrives(false)]); render(); };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  (async () => {
    render();
    if (!settings.origin) openHome();
    await Promise.all([loadWeather(false), loadDrives(false)]);
    render();
  })();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") { await loadWeather(false); render(); }
  });
})();
