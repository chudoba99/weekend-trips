// core.js — the shared brain of Weekend Trip Planner.
// Used by the web app (browser), the Scriptable widget (iPhone) and tests (node).
// No DOM, no imports: plain functions only.

const TZ = "Australia/Sydney";

// Fajr angles for the common calculation methods. Asr is always Hanafi (shadow factor 2)
// unless settings.asrFactor is changed.
const METHODS = {
  MWL:     { label: "Muslim World League", fajr: 18 },
  ISNA:    { label: "ISNA (North America)", fajr: 15 },
  Egypt:   { label: "Egyptian General Authority", fajr: 19.5 },
  Karachi: { label: "University of Karachi", fajr: 18 },
  Makkah:  { label: "Umm al-Qura, Makkah", fajr: 18.5 },
};

const DEFAULTS = {
  homeBy: "13:00",      // must be home by this time on morning trips
  maxDrive: 120,        // minutes, one way
  maxSunriseDrive: 80,  // minutes, one way from home: sunrise trips further than this are skipped
  maxFeels: 32,         // °C "feels like": windows hotter than this are dropped
  warmFrom: 26,         // °C: score starts dropping above this
  method: "MWL",
  asrFactor: 2,         // 2 = Hanafi, 1 = standard
  weekOffset: 0,        // 0 = this/coming weekend, 1 = the one after
  origin: null,         // { name, lat, lon }: where the couple lives; set by the user
};

// ---------- home location & drive times ----------

// Suburb search (Open-Meteo geocoding, free, no key).
function geocodeUrl(query) {
  return "https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&countryCode=AU&name=" +
    encodeURIComponent(query.trim());
}
function parseGeocode(json) {
  const all = (json && json.results) || [];
  const towns = all.filter((r) => /^PPL/.test(r.feature_code || ""));   // suburbs & towns, not parks
  return (towns.length ? towns : all).map((r) => ({
    name: r.name, region: [r.admin2, r.admin1].filter(Boolean).join(", "),
    lat: +r.latitude.toFixed(4), lon: +r.longitude.toFixed(4),
  }));
}

// Driving times from home to every place in one request (OSRM routing, free, no key).
function drivesUrl(origin, places) {
  const pts = [origin].concat(places).map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  return `https://router.project-osrm.org/table/v1/driving/${pts}?sources=0&annotations=duration`;
}
function parseDrives(json, places) {
  const out = {};
  if (!json || json.code !== "Ok") return out;
  places.forEach((p, i) => {
    const sec = json.durations[0][i + 1];
    if (sec !== null && sec !== undefined) out[p.id] = Math.max(5, Math.round(sec / 60 / 5) * 5);
  });
  return out;
}
// Fallback when routing is unreachable: straight-line distance × road factor at ~70 km/h.
function estimateDrive(origin, place) {
  const R = 6371, dLat = rad(place.lat - origin.lat), dLon = rad(place.lon - origin.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(origin.lat)) * Math.cos(rad(place.lat)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(a)) * 1.35;
  return Math.max(5, Math.round((km / 70) * 60 / 5) * 5);
}
// Copies of the places with driveMins measured from this origin.
function withDrives(places, origin, drives) {
  return places.map((p) => {
    const known = drives && drives[p.id];
    return Object.assign({}, p, {
      driveMins: known || estimateDrive(origin, p),
      driveApprox: !known,
    });
  });
}

// ---------- time helpers (all Dates are real instants; display is always Sydney time) ----------

const MIN = 60 * 1000;

function sydneyParts(date) {
  const f = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return {
    y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute,
    weekday: p.weekday, // "Sat", "Sun", ...
  };
}

// Sydney wall-clock time -> Date
function sydneyTime(y, m, d, h, min) {
  const target = Date.UTC(y, m - 1, d, h, min);
  let guess = target - 10 * 60 * MIN;
  for (let i = 0; i < 3; i++) {
    const p = sydneyParts(new Date(guess));
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += target - seen;
  }
  return new Date(guess);
}

function fmtTime(date) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date).replace(/\s/g, "").replace("am", " am").replace("pm", " pm");
}

function fmtDay(day) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "short",
  }).format(sydneyTime(day.y, day.m, day.d, 12, 0));
}

function addMin(date, mins) { return new Date(date.getTime() + mins * MIN); }

// The weekend days to plan for, as Sydney calendar dates.
function weekendDays(now, weekOffset) {
  now = now || new Date();
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const p = sydneyParts(now);
  const dow = order.indexOf(p.weekday);
  const noon = Date.UTC(p.y, p.m - 1, p.d, 12, 0);
  const at = (offset) => {
    const t = new Date(noon + offset * 24 * 60 * MIN);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  let satOffset = (6 - dow + 7) % 7;      // 0 on Saturday
  if (dow === 0) satOffset = -1;           // on Sunday, "this weekend" started yesterday
  satOffset += 7 * (weekOffset || 0);
  const days = [
    Object.assign({ label: "Sat" }, at(satOffset)),
    Object.assign({ label: "Sun" }, at(satOffset + 1)),
  ];
  return days.map((d) => Object.assign(d, { key: `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` }));
}

// ---------- prayer times (praytimes.org method, computed in UTC) ----------

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const fix = (a, b) => { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; };
const dsin = (d) => Math.sin(rad(d));
const dcos = (d) => Math.cos(rad(d));
const dtan = (d) => Math.tan(rad(d));
const darcsin = (x) => deg(Math.asin(x));
const darccos = (x) => deg(Math.acos(x));
const darctan2 = (y, x) => deg(Math.atan2(y, x));
const darccot = (x) => deg(Math.atan(1 / x));

function julian(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360);
  const q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g), 360);
  const e = 23.439 - 0.00000036 * D;
  const RA = darctan2(dcos(e) * dsin(L), dcos(L)) / 15;
  const eqt = q / 15 - fix(RA, 24);
  const decl = darcsin(dsin(e) * dsin(L));
  return { decl, eqt };
}

// Returns { fajr, sunrise, dhuhr, asr, maghrib } as Dates for a Sydney calendar day.
function prayerTimes(day, lat, lon, settings) {
  settings = Object.assign({}, DEFAULTS, settings || {});
  const method = METHODS[settings.method] || METHODS.MWL;
  const jd = julian(day.y, day.m, day.d) - lon / (15 * 24);

  const midDay = (t) => fix(12 - sunPosition(jd + t).eqt, 24);
  const angleTime = (angle, t, ccw) => {
    const { decl } = sunPosition(jd + t);
    const noon = midDay(t);
    const T = darccos((-dsin(angle) - dsin(decl) * dsin(lat)) / (dcos(decl) * dcos(lat))) / 15;
    return noon + (ccw ? -T : T);
  };
  const asrTime = (factor, t) => {
    const { decl } = sunPosition(jd + t);
    const angle = -darccot(factor + dtan(Math.abs(lat - decl)));
    return angleTime(angle, t);
  };

  // Two refinement passes, starting from rough default times.
  let t = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, maghrib: 18 };
  for (let i = 0; i < 2; i++) {
    t = {
      fajr: angleTime(method.fajr, t.fajr / 24, true),
      sunrise: angleTime(0.833, t.sunrise / 24, true),
      dhuhr: midDay(t.dhuhr / 24),
      asr: asrTime(settings.asrFactor, t.asr / 24),
      maghrib: angleTime(0.833, t.maghrib / 24),
    };
  }
  const base = Date.UTC(day.y, day.m - 1, day.d, 0, 0);
  const out = {};
  for (const k in t) {
    const hours = t[k] - lon / 15;             // local solar -> UTC hours
    out[k] = new Date(base + Math.round(hours * 60) * MIN);
  }
  return out;
}

// ---------- weather (Open-Meteo, no key) ----------

const WEATHER_CODES = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 80: "Showers", 81: "Showers", 82: "Heavy showers",
  95: "Thunderstorms", 96: "Thunderstorms", 99: "Thunderstorms",
};
const WEATHER_ICON = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "🌧️",
  80: "🌦️", 81: "🌧️", 82: "🌧️", 95: "⛈️", 96: "⛈️", 99: "⛈️",
};

const HOURLY = [
  "apparent_temperature", "precipitation_probability", "precipitation", "weather_code",
  "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "uv_index",
];

function weatherUrl(places) {
  const lat = places.map((p) => p.lat.toFixed(4)).join(",");
  const lon = places.map((p) => p.lon.toFixed(4)).join(",");
  return "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=${HOURLY.join(",")}` +
    "&timeformat=unixtime&timezone=GMT&past_days=3&forecast_days=16";
}

// Open-Meteo answer -> { placeId: { time: [unix...], <var>: [...] } }
function parseWeather(json, places) {
  const list = Array.isArray(json) ? json : [json];
  const out = {};
  places.forEach((p, i) => { if (list[i] && list[i].hourly) out[p.id] = list[i].hourly; });
  return out;
}

function hoursBetween(h, from, to) {
  const a = Math.floor(from.getTime() / 3600000) * 3600;
  const b = Math.ceil(to.getTime() / 3600000) * 3600;
  const idx = [];
  for (let i = 0; i < h.time.length; i++) if (h.time[i] >= a && h.time[i] <= b) idx.push(i);
  return idx;
}

function hourAt(h, when) {
  const t = Math.round(when.getTime() / 3600000) * 3600;
  return h.time.indexOf(t);
}

function summarise(h, from, to) {
  const idx = hoursBetween(h, from, to);
  if (!idx.length) return null;
  const vals = (k) => idx.map((i) => h[k][i]).filter((v) => v !== null && v !== undefined);
  const max = (k) => { const v = vals(k); return v.length ? Math.max(...v) : null; };
  const min = (k) => { const v = vals(k); return v.length ? Math.min(...v) : null; };
  const codes = vals("weather_code");
  const worst = codes.length ? Math.max(...codes) : null;
  return {
    feelsMax: max("apparent_temperature"), feelsMin: min("apparent_temperature"),
    rainMax: max("precipitation_probability"), uvMax: max("uv_index"),
    code: worst, text: WEATHER_CODES[worst] || "—", icon: WEATHER_ICON[worst] || "🌡️",
  };
}

function skyAt(h, when) {
  const i = hourAt(h, when);
  if (i < 0) return null;
  return {
    low: h.cloud_cover_low[i], mid: h.cloud_cover_mid[i], high: h.cloud_cover_high[i],
    rain: h.precipitation_probability[i], code: h.weather_code[i],
  };
}

function rainBefore(h, when, hours) {
  let sum = 0;
  const end = when.getTime() / 1000;
  const start = end - hours * 3600;
  for (let i = 0; i < h.time.length; i++) {
    if (h.time[i] >= start && h.time[i] < end && h.precipitation[i]) sum += h.precipitation[i];
  }
  return sum;
}

// ---------- planning ----------

function parseHM(s) { const [h, m] = s.split(":").map(Number); return { h, m }; }

// Build the timeline for one place / day / kind. Returns null if it doesn't fit the rules.
function timeline(kind, place, day, homePrayers, here, settings) {
  const drive = place.driveMins;
  const walk = place.mins;
  const hb = parseHM(settings.homeBy);
  const homeBy = sydneyTime(day.y, day.m, day.d, hb.h, hb.m);
  let leaveHome, startWalk, endWalk, homeAt, watch;

  if (kind === "morning") {
    // Start soon after sunrise to beat the heat, but not before 6:30 am (dawn starts are "sunrise" trips).
    const earliest = sydneyTime(day.y, day.m, day.d, 6, 30);
    const afterSun = addMin(here.sunrise, 20);
    startWalk = afterSun > earliest ? afterSun : earliest;
    if (place.gates && place.gates.open) {
      const g = parseHM(place.gates.open);
      const opens = sydneyTime(day.y, day.m, day.d, g.h, g.m);
      if (startWalk < opens) startWalk = opens;
    }
    leaveHome = addMin(startWalk, -drive);
    endWalk = addMin(startWalk, walk);
    homeAt = addMin(endWalk, 20 + drive);
    if (homeAt > homeBy) return null;
  } else if (kind === "sunrise") {
    startWalk = addMin(here.sunrise, -25 - walk / 2);
    leaveHome = addMin(startWalk, -drive);
    watch = here.sunrise;
    endWalk = addMin(here.sunrise, 30 + walk / 2);
    homeAt = addMin(endWalk, 15 + drive);
    if (homeAt > homeBy) return null;
  } else if (kind === "evening") {
    leaveHome = addMin(homePrayers.asr, 15);
    startWalk = addMin(leaveHome, drive);
    endWalk = addMin(startWalk, walk);
    if (endWalk > addMin(here.maghrib, -10)) return null;
    homeAt = addMin(endWalk, 15 + drive);
  } else if (kind === "sunset") {
    leaveHome = addMin(homePrayers.asr, 15);
    const arrive = addMin(leaveHome, drive);
    if (addMin(arrive, walk / 2) > addMin(here.maghrib, -20)) return null;
    const ideal = addMin(here.maghrib, -30 - walk / 2);
    startWalk = arrive > ideal ? arrive : ideal;
    watch = here.maghrib;
    endWalk = addMin(here.maghrib, 15 + walk / 2);
    homeAt = addMin(endWalk, 10 + drive);
  }
  // Park gates: you must arrive after they open and be back at the car before they close.
  if (place.gates) {
    const at = (s) => { const g = parseHM(s); return sydneyTime(day.y, day.m, day.d, g.h, g.m); };
    if (place.gates.open && startWalk < at(place.gates.open)) return null;
    if (place.gates.close && endWalk > addMin(at(place.gates.close), -10)) return null;
  }
  return { leaveHome, startWalk, endWalk, homeAt, watch };
}

function prayerNote(kind, t, home, here) {
  const notes = [];
  if (kind === "morning" || kind === "sunrise") {
    if (t.leaveHome >= addMin(home.fajr, 10)) {
      notes.push(`Pray Fajr at home (from ${fmtTime(home.fajr)}), then leave by ${fmtTime(t.leaveHome)}.`);
    } else {
      notes.push(`Fajr starts ${fmtTime(home.fajr)} while you're driving. Pray when you arrive, before sunrise at ${fmtTime(here.sunrise)}.`);
    }
    if (t.homeAt <= home.dhuhr) notes.push(`Home before Dhuhr (${fmtTime(home.dhuhr)}).`);
    else notes.push(`Dhuhr is ${fmtTime(home.dhuhr)}, just before you get home. Pray on the way or at home.`);
  } else {
    notes.push(`Pray Asr at home (${fmtTime(home.asr)}), then leave by ${fmtTime(t.leaveHome)}.`);
    if (kind === "sunset") {
      notes.push(`Maghrib is at sunset (${fmtTime(here.maghrib)}). Plan to pray it at the lookout or the car park.`);
    } else {
      notes.push(`Maghrib is ${fmtTime(here.maghrib)}. You'll be back at the car by then, so pray there or on the way home.`);
    }
  }
  return notes;
}

function scoreTrip(kind, place, w, sky, recentRain, settings) {
  const reasons = [];
  let s = 100;

  if (!w) return { score: null, reasons: ["No forecast yet"] };
  if (w.feelsMax !== null && w.feelsMax > settings.maxFeels) return { score: null, reasons: [`Too hot (feels ${Math.round(w.feelsMax)}°)`] };
  if (w.rainMax !== null && w.rainMax > 60) return { score: null, reasons: [`Likely rain (${w.rainMax}%)`] };
  if (w.code >= 95) return { score: null, reasons: ["Thunderstorms"] };

  if (w.feelsMax > settings.warmFrom) {
    const shadeFactor = place.shade === "shaded" ? 0.4 : place.shade === "partial" ? 0.75 : 1;
    const p = (w.feelsMax - settings.warmFrom) * 6 * shadeFactor;
    s -= p;
    reasons.push(place.shade === "shaded" ? "Warm, but the track is shaded" : "Warm");
  } else if (w.feelsMax !== null && w.feelsMax >= 16) {
    reasons.push("Comfortable temperature");
  }
  if (w.feelsMin !== null && w.feelsMin < 8) s -= (8 - w.feelsMin) * 2;
  if (w.rainMax > 30) { s -= (w.rainMax - 30) * 1.2; reasons.push(`Some chance of rain (${w.rainMax}%)`); }
  if ((w.code === 45 || w.code === 48) && place.highlight !== "waterfall") { s -= 30; reasons.push("Fog may hide the view"); }
  if (w.uvMax >= 8 && place.shade === "exposed") { s -= 10; reasons.push("High UV on an exposed track"); }

  if (kind === "sunrise" || kind === "sunset") {
    if (!sky) return { score: null, reasons: ["No forecast for that hour"] };
    if (sky.low > 60 || sky.rain > 30 || sky.code === 45 || sky.code === 48) {
      return { score: null, reasons: [`Low cloud or rain at ${kind}`] };
    }
    s -= sky.low * 0.5;
    const upper = Math.max(sky.mid, sky.high);
    if (upper >= 20 && upper <= 70 && sky.low < 30) { s += 18; reasons.push(`Good ${kind} colour likely (high cloud, clear below)`); }
    else if (sky.low + sky.mid + sky.high < 15) { s += 6; reasons.push(`Clear sky for ${kind}`); }
    s += 4; // a sunrise/sunset is a treat
  }

  if (place.highlight !== "view") {
    if (recentRain >= 10) { s += 12; reasons.push(`Falls should be flowing (${Math.round(recentRain)} mm in the last 3 days)`); }
    else if (recentRain >= 3) { s += 6; reasons.push("Some recent rain for the falls"); }
    else if (place.highlight === "waterfall") { s -= 4; reasons.push("Dry lately, falls may be a trickle"); }
  }
  if (place.highlight === "both") s += 3;
  s -= Math.max(0, place.driveMins - 30) * 0.1;
  if (place.toilets) s += 3;

  return { score: Math.round(Math.max(1, Math.min(130, s))), reasons };
}

// Main entry: every trip that fits, scored, for the given days.
function planTrips(places, weather, days, settings, now) {
  settings = Object.assign({}, DEFAULTS, settings || {});
  now = now || new Date();
  const trips = [];
  const origin = settings.origin;
  if (!origin) return trips;
  for (const day of days) {
    const home = prayerTimes(day, origin.lat, origin.lon, settings);
    for (const place of places) {
      if (place.driveMins > settings.maxDrive) continue;
      const here = prayerTimes(day, place.lat, place.lon, settings);
      const h = weather[place.id];
      const kinds = ["morning", "evening"];
      if (place.sunrise && place.driveMins <= settings.maxSunriseDrive) kinds.push("sunrise");
      if (place.sunset) kinds.push("sunset");
      for (const kind of kinds) {
        const t = timeline(kind, place, day, home, here, settings);
        if (!t) continue;
        if (t.leaveHome < now) continue;      // already too late
        const w = h ? summarise(h, t.startWalk, t.endWalk) : null;
        const sky = h && t.watch ? skyAt(h, t.watch) : null;
        const recentRain = h ? rainBefore(h, t.startWalk, 72) : 0;
        const { score, reasons } = scoreTrip(kind, place, w, sky, recentRain, settings);
        trips.push({
          id: `${place.id}|${day.key}|${kind}`,
          place, day, kind, score, reasons, weather: w, sky, recentRain,
          ...t, prayers: home, here, notes: prayerNote(kind, t, home, here),
        });
      }
    }
  }
  return trips;
}

// Best few trips for one day: valid ones only, one per place, highest score first.
function bestForDay(trips, dayKey, limit) {
  const byPlace = {};
  for (const t of trips) {
    if (t.day.key !== dayKey || t.score === null) continue;
    if (!byPlace[t.place.id] || byPlace[t.place.id].score < t.score) byPlace[t.place.id] = t;
  }
  return Object.values(byPlace).sort((a, b) => b.score - a.score).slice(0, limit || 99);
}

function bestOverall(trips, limit) {
  const byPlace = {};
  for (const t of trips) {
    if (t.score === null) continue;
    if (!byPlace[t.place.id] || byPlace[t.place.id].score < t.score) byPlace[t.place.id] = t;
  }
  return Object.values(byPlace).sort((a, b) => b.score - a.score).slice(0, limit || 99);
}

const KIND_LABEL = { morning: "Morning", sunrise: "Sunrise", evening: "Evening", sunset: "Sunset" };

function mapsLinks(place, platform) {
  const ll = `${place.lat},${place.lon}`;
  const q = encodeURIComponent(`${place.name} car park`);
  const google = `https://www.google.com/maps/dir/?api=1&destination=${ll}`;
  let primary = google;
  if (platform === "ios") primary = `https://maps.apple.com/?daddr=${ll}&q=${q}`;
  else if (platform === "android") primary = `geo:${ll}?q=${ll}(${q})`;
  return { primary, google };
}

const Core = {
  TZ, METHODS, DEFAULTS, KIND_LABEL,
  geocodeUrl, parseGeocode, drivesUrl, parseDrives, estimateDrive, withDrives,
  sydneyParts, sydneyTime, fmtTime, fmtDay, addMin, weekendDays,
  prayerTimes, weatherUrl, parseWeather, planTrips, bestForDay, bestOverall, mapsLinks,
};
if (typeof module !== "undefined") module.exports = Core;
