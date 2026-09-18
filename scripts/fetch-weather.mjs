#!/usr/bin/env node
/**
 * Daily weather snapshot for the Thailand travel guide.
 *
 * Run by .github/workflows/weather.yml once a day (and on demand). It writes
 * weather-data.txt, which the website fetches automatically on the first visit
 * of each day — so the page still shows today's weather when the public APIs
 * are rate-limited, blocked or offline.
 *
 * Source:  Open-Meteo (keyless)  →  wttr.in (keyless)  →  previous record in the
 *          repo  →  seasonal climate estimate from the table below.
 *
 * The file format is deliberately dead simple: comment lines, then one JSON
 * object. index.html parses it with parseWeatherFile().
 *
 * Usage:  node scripts/fetch-weather.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'weather-data.txt');
const DAY_TZ = 'Asia/Kolkata';          // day keys are computed in IST, like most readers of this site
const TIMEOUT_MS = 12000;

const CITIES = {
  phuket: { name: 'Phuket', lat: 7.8804, lon: 98.3923 },
  krabi: { name: 'Krabi', lat: 8.0863, lon: 98.9063 },
  bangkok: { name: 'Bangkok', lat: 13.7563, lon: 100.5018 }
};

/* typical monthly climate: [temp °C, rain days %, crowd index %] — also used as the offline estimate */
const CLIMATE = {
  phuket: [[28, 20, 85], [29, 15, 90], [30, 25, 80], [31, 50, 65], [30, 75, 40], [29, 80, 35], [28, 82, 40], [28, 78, 45], [28, 85, 35], [28, 70, 50], [28, 35, 75], [27, 20, 95]],
  krabi: [[28, 15, 80], [29, 10, 85], [31, 20, 75], [32, 45, 60], [30, 70, 35], [29, 78, 30], [28, 75, 35], [28, 72, 40], [28, 82, 30], [27, 65, 45], [28, 40, 70], [27, 18, 90]],
  bangkok: [[27, 10, 70], [28, 8, 75], [30, 15, 70], [32, 30, 60], [31, 50, 50], [29, 65, 45], [29, 68, 50], [29, 70, 55], [28, 80, 40], [28, 72, 45], [28, 30, 65], [26, 12, 80]]
};

const WMO = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '⛈️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'],
  82: ['Violent showers', '⛈️'], 95: ['Thunderstorm', '⛈️'], 96: ['Storm with hail', '⛈️'], 99: ['Severe storm', '⛈️']
};
const wmo = code => WMO[code] || ['Unsettled', '🌤️'];
const pad = n => String(n).padStart(2, '0');
const round = n => Math.round(Number(n) || 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** YYYY-MM-DD in the given timezone (en-CA formats exactly that way). */
function dayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'thailand-guide-weather-bot/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------- providers ---------------------------------- */

async function fetchOpenMeteo(city) {
  const c = CITIES[city];
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${c.lat}&longitude=${c.lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,uv_index' +
    '&hourly=temperature_2m,precipitation_probability,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max' +
    '&timezone=Asia%2FBangkok&forecast_days=7';
  const j = await getJson(url);
  if (!j.current || !j.daily) throw new Error('open-meteo: unexpected payload');

  const h = j.hourly || { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [] };
  const currentKey = String(j.current.time || '').slice(0, 13);
  let start = h.time.findIndex(t => t.slice(0, 13) === currentKey);
  if (start < 0) start = 0;

  const hourly = [];
  for (let i = start; i < Math.min(start + 24, h.time.length); i++) {
    hourly.push({
      t: h.time[i].slice(11, 16),
      temp: round(h.temperature_2m[i]),
      rain: h.precipitation_probability[i] || 0,
      code: h.weather_code[i]
    });
  }
  const code = j.current.weather_code;
  return {
    provider: 'Open-Meteo',
    fetchedAt: new Date().toISOString(),
    current: {
      temp: round(j.current.temperature_2m), feels: round(j.current.apparent_temperature),
      humidity: j.current.relative_humidity_2m, wind: round(j.current.wind_speed_10m),
      windDir: j.current.wind_direction_10m, rain: j.current.precipitation || 0,
      cloud: j.current.cloud_cover, uv: j.current.uv_index, code,
      label: wmo(code)[0], icon: wmo(code)[1]
    },
    rainChance: Math.max(0, ...hourly.slice(0, 12).map(x => x.rain)),
    hourly,
    daily: j.daily.time.map((d, i) => ({
      date: d,
      max: round(j.daily.temperature_2m_max[i]), min: round(j.daily.temperature_2m_min[i]),
      code: j.daily.weather_code[i], rain: j.daily.precipitation_probability_max[i],
      uv: j.daily.uv_index_max[i],
      sunrise: String(j.daily.sunrise[i] || '').slice(11, 16), sunset: String(j.daily.sunset[i] || '').slice(11, 16)
    }))
  };
}

async function fetchWttr(city) {
  const j = await getJson('https://wttr.in/' + encodeURIComponent(CITIES[city].name) + '?format=j1');
  const cur = (j.current_condition || [])[0];
  if (!cur) throw new Error('wttr: unexpected payload');
  const code = parseInt(cur.weatherCode, 10) || 0;
  const days = j.weather || [];
  const hourly = (days[0] ? days[0].hourly : []).map(x => ({
    t: pad(Math.floor(parseInt(x.time, 10) / 100)) + ':00',
    temp: round(x.tempC),
    rain: round(x.chanceofrain),
    code: parseInt(x.weatherCode, 10) || 0
  }));
  return {
    provider: 'wttr.in',
    fetchedAt: new Date().toISOString(),
    current: {
      temp: round(cur.temp_C), feels: round(cur.FeelsLikeC), humidity: parseInt(cur.humidity, 10),
      wind: round(cur.windspeedKmph), windDir: parseInt(cur.winddirDegree, 10), rain: parseFloat(cur.precipMM) || 0,
      cloud: parseInt(cur.cloudcover, 10), uv: parseInt(cur.uvIndex, 10), code,
      label: (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || wmo(code)[0], icon: wmo(code)[1]
    },
    rainChance: Math.max(0, ...hourly.slice(0, 12).map(x => x.rain)),
    hourly,
    daily: days.map(d => ({
      date: d.date, max: round(d.maxtempC), min: round(d.mintempC),
      code: parseInt((((d.hourly || [])[4] || {}).weatherCode), 10) || 0,
      rain: Math.max(0, ...(d.hourly || []).map(x => round(x.chanceofrain))),
      uv: parseInt(d.uvIndex, 10) || 0,
      sunrise: d.astronomy && d.astronomy[0] ? d.astronomy[0].sunrise : '',
      sunset: d.astronomy && d.astronomy[0] ? d.astronomy[0].sunset : ''
    }))
  };
}

/** Deterministic seasonal stand-in so the file always contains three usable records. */
function estimate(city, dayKey) {
  const [temp, rain] = CLIMATE[city][new Date(dayKey + 'T12:00:00Z').getUTCMonth()];
  const code = rain > 55 ? 61 : rain > 30 ? 2 : 0;
  const seed = [...city].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) + Number(dayKey.replace(/-/g, ''));
  let x = seed % 9973;
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    t: pad(i) + ':00',
    temp: round(temp - 3 + Math.sin((i - 4) / 24 * Math.PI * 2) * 3.5 + rnd()),
    rain: clamp(round(rain + (rnd() - .5) * 22), 0, 95),
    code
  }));
  const daily = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(dayKey + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      max: round(temp + 3 + rnd() * 2), min: round(temp - 4 + rnd() * 2),
      code, rain: clamp(round(rain + (rnd() - .5) * 20), 0, 95), uv: 9,
      sunrise: '06:20', sunset: '18:30'
    };
  });
  return {
    provider: 'seasonal estimate',
    estimated: true, fetchedAt: null,
    current: {
      temp, feels: temp + 4, humidity: 74, wind: 11, windDir: 220, rain: rain > 50 ? 1.2 : 0,
      cloud: 45, uv: 8, code, label: wmo(code)[0] + ' (seasonal average)', icon: wmo(code)[1]
    },
    rainChance: rain, hourly, daily
  };
}

/* ---------------------------------- file helpers ---------------------------------- */

async function readExisting() {
  try {
    const text = await readFile(OUT, 'utf8');
    const body = text.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
    const start = body.indexOf('{');
    if (start < 0) return null;
    const parsed = JSON.parse(body.slice(start));
    return parsed && parsed.days ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchThbPerInr() {
  const providers = [
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/INR'],
    ['frankfurter.app', 'https://api.frankfurter.app/latest?from=INR&to=THB']
  ];
  for (const [name, url] of providers) {
    try {
      const j = await getJson(url);
      const rate = Number(j && j.rates && j.rates.THB);
      if (rate > 0.05 && rate < 3) return { rate, source: name };
    } catch { /* try the next provider */ }
  }
  return { rate: 0.42, source: 'fallback' };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const today = dayInTz(DAY_TZ);
  const existing = await readExisting();
  const previous = (existing && existing.days && (existing.days[today] || existing.days[existing.day])) || {};
  const { rate, source: fxSource } = await fetchThbPerInr();

  const record = {};
  const notes = [];
  let liveCount = 0;

  for (const city of Object.keys(CITIES)) {
    let fresh = null;
    for (const provider of [fetchOpenMeteo, fetchWttr]) {
      try { fresh = await provider(city); break; } catch (err) {
        notes.push(`${city}: ${provider.name} failed (${err.message})`);
      }
    }
    if (fresh) {
      liveCount++;
      record[city] = { data: fresh, src: `live · ${fresh.provider} (repo file)`, at: new Date().toISOString(), thb: rate };
      console.log(`ok   ${city.padEnd(8)} ${fresh.current.temp}°C ${fresh.current.label} via ${fresh.provider}`);
    } else if (previous[city]) {
      record[city] = { ...previous[city], src: String(previous[city].src || 'saved').replace(/\s*\(repo file\)$/, '') + ' (carried over)' };
      notes.push(`${city}: keeping the previous record from the repo`);
      console.log(`warn ${city.padEnd(8)} live fetch failed — carried over the previous record`);
    } else {
      record[city] = { data: estimate(city, today), src: 'seasonal estimate (repo file)', at: null, thb: rate };
      notes.push(`${city}: no live data and nothing to carry over — used the seasonal estimate`);
      console.log(`warn ${city.padEnd(8)} live fetch failed — seasonal estimate written`);
    }
  }

  const alreadyHaveToday = !!(existing && existing.day === today && existing.days && existing.days[today]);
  if (liveCount === 0 && alreadyHaveToday) {
    console.log('\nNo live data available and the repo already holds a record for today — leaving the file untouched.');
    return;
  }

  const header = [
    '# Thailand trip planner — daily weather cache',
    `# generated: ${new Date().toISOString()}  (day key ${today}, ${DAY_TZ})`,
    `# cities: ${Object.keys(CITIES).map(c => `${CITIES[c].name} (${c})`).join(', ')}`,
    `# sources: Open-Meteo → wttr.in → previous repo record → seasonal estimate (live records: ${liveCount}/3)`,
    `# fx: 1 INR = ${rate} THB via ${fxSource}`,
    '# refreshed automatically by .github/workflows/weather.yml — keep this file next to index.html',
    ...notes.map(n => '# note: ' + n),
    '',
    '# Only today is kept: the front-end deletes older days on its first load of a new day.',
    ''
  ].join('\n');

  const payload = { v: 2, day: today, days: { [today]: record } };
  await writeFile(OUT, header + JSON.stringify(payload, null, 1) + '\n', 'utf8');
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)} for ${today} (${liveCount}/3 live records, fx ${rate}).`);
}

main().catch(err => {
  console.error('weather fetch failed:', err);
  process.exit(1);
});
