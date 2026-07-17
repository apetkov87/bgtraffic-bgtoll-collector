import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_URL = process.env.BGTOLL_WEATHER_PAGE || 'https://bgtoll.bg/mto/';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_WEATHER_OUTPUT || 'collector-output/weather.json');
const DIAG = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');
const VERSION = '2.3.0';
const MIN_RECORDS = Math.max(1, Number(process.env.BGTRAFFIC_WEATHER_MIN_RECORDS || 5));
const WAIT_MS = Math.max(10000, Number(process.env.BGTRAFFIC_WEATHER_WAIT_MS || 30000));
const records = new Map();
const pending = new Set();
const diagnostics = {
  officialPage: PAGE_URL,
  startedAt: new Date().toISOString(),
  pageStatus: null,
  finalPageUrl: null,
  matchedResponses: [],
  fetchAttempts: [],
  inlineObjects: 0,
  recordCount: 0,
  pageError: null,
};

const clean = (v) => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const key = (v) => clean(v).toLowerCase().replace(/[^a-zа-я0-9]+/gu, '');
const num = (v) => {
  if (typeof v === 'string') v = v.trim().replace(/\s+/g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  for (const wanted of names) {
    const found = keys.find((candidate) => key(candidate) === key(wanted));
    if (found && obj[found] !== '' && obj[found] != null) return obj[found];
  }
  for (const wanted of names) {
    const found = keys.find((candidate) => key(candidate).includes(key(wanted)));
    if (found && obj[found] !== '' && obj[found] != null) return obj[found];
  }
  return null;
}
function iso(value) {
  if (value == null || value === '') return new Date().toISOString();
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    let ts = Number(value); if (ts < 2e10) ts *= 1000;
    const d = new Date(ts); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  let raw = clean(value);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw = `${raw.replace(' ', 'T')}Z`;
  const d = new Date(raw); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function coords(obj) {
  let lat = num(pick(obj, ['lat','latitude','geographic_latitude','y','ширина']));
  let lon = num(pick(obj, ['lon','lng','longitude','geographic_longitude','x','дължина']));
  const geometry = obj.geometry || obj.geom;
  if ((lat == null || lon == null) && geometry && typeof geometry === 'object') {
    lon = num(geometry.x ?? geometry.longitude ?? geometry.lng);
    lat = num(geometry.y ?? geometry.latitude ?? geometry.lat);
  }
  const c = pick(obj, ['coordinates','coordinate','latlng','position']);
  if ((lat == null || lon == null) && Array.isArray(c) && c.length > 1) {
    const a = num(c[0]), b = num(c[1]);
    if (a != null && b != null) { if (a >= 40 && a <= 45) { lat = a; lon = b; } else { lon = a; lat = b; } }
  }
  if (lat != null && lon != null && (Math.abs(lon) > 180 || Math.abs(lat) > 90)) {
    lon = lon / 20037508.34 * 180;
    lat = lat / 20037508.34 * 180;
    lat = 180 / Math.PI * (2 * Math.atan(Math.exp(lat * Math.PI / 180)) - Math.PI / 2);
  }
  return [lat, lon];
}
function normalize(value, sourceUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value.attributes && typeof value.attributes === 'object' ? { ...value.attributes, geometry: value.geometry } : value.properties && typeof value.properties === 'object' ? { ...value.properties, geometry: value.geometry } : value;
  const [latitude, longitude] = coords(obj);
  if (latitude == null || longitude == null || latitude < 40 || latitude > 45 || longitude < 20 || longitude > 30) return null;
  const air = num(pick(obj, ['air','air_temperature','temperature_air','airTemp','temp_air','tair','температуравъздух','температуранавъздуха']));
  const surface = num(pick(obj, ['surface','road_temperature','temperature_road','surface_temperature','roadTemp','pavement_temperature','температуранастилка','температуранапътнатанастилка']));
  const humidity = num(pick(obj, ['humidity','relative_humidity','rh','влажност','относителнавлажност']));
  const pressure = num(pick(obj, ['pressure','atmospheric_pressure','barometer','налягане','атмосферноналягане']));
  const windSpeed = num(pick(obj, ['wind_speed','windspeed','wind','скоростнавятъра','вятър']));
  const windDirection = clean(pick(obj, ['wind_direction','winddirection','wind_dir','посоканавятъра']) ?? '');
  const precipitation = num(pick(obj, ['precipitation','rain','rainfall','валеж','валежи']));
  if ([air, surface, humidity, pressure, windSpeed, precipitation].every((item) => item == null)) return null;
  const stationId = clean(pick(obj, ['station_id','stationId','external_id','stationcode','id','code']) ?? `${latitude.toFixed(6)}|${longitude.toFixed(6)}`);
  const scp = clean(pick(obj, ['scp','control_point','controlPoint']) ?? '');
  const name = clean(pick(obj, ['name','station_name','stationName','title','location','наименование','местоположение']) ?? (scp ? `Метеостанция ${scp}` : `Пътна метеостанция ${stationId}`));
  const measuredAt = iso(pick(obj, ['measured_at','measuredAt','timestamp','time','date','updated_at','datetime']));
  return {
    external_id: stationId, scp, name, latitude, longitude,
    temperature_air: air, temperature_road: surface, humidity, pressure,
    wind_speed: windSpeed, wind_direction: windDirection || null, precipitation,
    measured_at: measuredAt,
    captured_from: sourceUrl,
    source_extra: Object.fromEntries(Object.entries(obj).filter(([,v]) => ['string','number','boolean'].includes(typeof v)).slice(0,120)),
  };
}
function add(record) {
  if (!record) return;
  const id = `${record.external_id}|${record.latitude.toFixed(5)}|${record.longitude.toFixed(5)}`;
  const old = records.get(id);
  if (!old || Date.parse(record.measured_at) >= Date.parse(old.measured_at)) records.set(id, record);
}
function walk(value, sourceUrl, depth = 0, seen = new WeakSet()) {
  if (depth > 18 || value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) walk(item, sourceUrl, depth + 1, seen); return; }
  add(normalize(value, sourceUrl));
  for (const child of Object.values(value)) walk(child, sourceUrl, depth + 1, seen);
}
function parseText(text, sourceUrl) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return 0;
  const before = records.size;
  try { walk(JSON.parse(raw), sourceUrl); } catch {}
  return records.size - before;
}
async function inspect(response) {
  const request = response.request();
  const url = response.url();
  const type = request.resourceType();
  const contentType = (await response.headerValue('content-type')) || '';
  if (response.status() < 200 || response.status() >= 400) return;
  if (!['xhr','fetch','document','script'].includes(type) && !/json|javascript|text/i.test(contentType)) return;
  if (!/mto|weather|meteo|meteor|station|data|json/i.test(`${url} ${contentType}`)) return;
  try {
    const body = await response.body();
    if (!body.length || body.length > 40 * 1024 * 1024) return;
    const added = parseText(body.toString('utf8'), url);
    if (added > 0) diagnostics.matchedResponses.push({ url, status: response.status(), resourceType: type, contentType, added });
  } catch {}
}

await fs.mkdir(DIAG, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'bg-BG', timezoneId: 'Europe/Sofia', viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.7', DNT: '1' },
});
context.on('response', (response) => { const task = inspect(response).finally(() => pending.delete(task)); pending.add(task); });
const page = await context.newPage();
try {
  const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  diagnostics.pageStatus = response?.status() ?? null;
  diagnostics.finalPageUrl = page.url();
  await page.waitForTimeout(WAIT_MS);
  await Promise.allSettled([...pending]);

  // Same-origin browser fetch: this keeps the cookies/session that BGTOLL requires.
  if (records.size < MIN_RECORDS) {
    const endpoints = [
      '/index.php/mto/data', '/mto/data', '/index.php/MTO/data',
      '/index.php/weather/data', '/index.php/road_weather/data', '/index.php/meteo/data',
    ];
    const fetched = await page.evaluate(async (paths) => {
      const out = [];
      for (const path of paths) {
        try {
          const response = await fetch(path, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json,text/plain,*/*' } });
          out.push({ url: response.url, status: response.status, contentType: response.headers.get('content-type') || '', text: await response.text() });
        } catch (error) { out.push({ url: path, status: 0, error: String(error) }); }
      }
      return out;
    }, endpoints);
    for (const item of fetched) {
      const added = item.status >= 200 && item.status < 400 ? parseText(item.text, item.url) : 0;
      diagnostics.fetchAttempts.push({ url: item.url, status: item.status, contentType: item.contentType || '', bytes: item.text?.length || 0, added, error: item.error || null });
    }
  }

  // Some releases expose the array directly in a global variable.
  if (records.size < MIN_RECORDS) {
    const objects = await page.evaluate(() => {
      const result = [];
      for (const name of Object.getOwnPropertyNames(window)) {
        if (!/mto|weather|meteo|station|data/i.test(name)) continue;
        try {
          const value = window[name];
          if (value && typeof value === 'object') result.push({ name, value: JSON.parse(JSON.stringify(value)) });
        } catch {}
        if (result.length >= 50) break;
      }
      return result;
    });
    diagnostics.inlineObjects = objects.length;
    for (const object of objects) walk(object.value, `${PAGE_URL}#window.${object.name}`);
  }
  await page.screenshot({ path: path.join(DIAG, 'bgtoll-mto-weather.png'), fullPage: true });
} catch (error) {
  diagnostics.pageError = String(error?.message || error);
}

const list = [...records.values()].sort((a,b) => a.external_id.localeCompare(b.external_id, 'bg'));
diagnostics.recordCount = list.length;
diagnostics.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(DIAG, 'bgtoll-weather-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
if (list.length < MIN_RECORDS) {
  await browser.close();
  const attempts = diagnostics.fetchAttempts.map((x) => `${x.status} ${x.url}`).join('; ');
  throw new Error(`Не са разпознати пътни метеостанции от ${PAGE_URL}. Страница: HTTP ${diagnostics.pageStatus ?? '—'}; прихванати отговори: ${diagnostics.matchedResponses.length}; записи: ${list.length}.${attempts ? ` Проверени: ${attempts}` : ''}`);
}
const payload = {
  source: 'bgtoll_weather', schema_version: 1, collector_version: VERSION,
  collected_at: new Date().toISOString(), official_page: PAGE_URL,
  captured_from: diagnostics.matchedResponses[0]?.url || diagnostics.fetchAttempts.find((x) => x.added > 0)?.url || PAGE_URL,
  records: list,
  diagnostics: { matched_responses: diagnostics.matchedResponses.slice(0,20), fetch_attempts: diagnostics.fetchAttempts, page_status: diagnostics.pageStatus },
};
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
await browser.close();
console.log(JSON.stringify({ success: true, weatherRecords: list.length, capturedFrom: payload.captured_from }, null, 2));
