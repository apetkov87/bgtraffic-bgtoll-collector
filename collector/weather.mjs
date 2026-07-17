import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const OPEN_DATA_PAGE = process.env.BGTOLL_OPEN_DATA_PAGE || 'https://bgtoll.bg/otvoreni-danni';
const LEGACY_PAGE = process.env.BGTOLL_WEATHER_PAGE || '';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_WEATHER_OUTPUT || 'collector-output/weather.json');
const DIAG = path.resolve('collector-diagnostics');
const VERSION = '2.1.0';
const MIN_RECORDS = Math.max(1, Number(process.env.BGTRAFFIC_WEATHER_MIN_RECORDS || 5));

const records = new Map();
const diagnostics = {
  openDataPage: OPEN_DATA_PAGE,
  pageStatus: null,
  pageError: null,
  candidateCount: 0,
  candidates: [],
  requests: [],
  matchedResponses: [],
  recordCount: 0,
};

const clean = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const numberValue = (value) => {
  if (typeof value === 'string') value = value.trim().replace(',', '.');
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const pick = (object, keys) => {
  if (!object || typeof object !== 'object') return null;
  const entries = Object.keys(object);
  for (const key of keys) {
    const exact = entries.find((entry) => entry.toLowerCase() === key.toLowerCase());
    if (exact && object[exact] !== '' && object[exact] != null) return object[exact];
  }
  return null;
};
const isoUtc = (value) => {
  if (value == null || value === '') return new Date().toISOString();
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    let timestamp = Number(value);
    if (timestamp < 2e10) timestamp *= 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  const raw = clean(value);
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)
    ? raw.replace(' ', 'T') + (explicitZone ? '' : 'Z')
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

function normalize(object, context = {}) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;

  let latitude = numberValue(pick(object, ['lat', 'latitude', 'y']));
  let longitude = numberValue(pick(object, ['lon', 'lng', 'longitude', 'x']));
  const coordinates = pick(object, ['coordinates', 'latlng', 'position']);
  if ((latitude == null || longitude == null) && Array.isArray(coordinates) && coordinates.length > 1) {
    const first = numberValue(coordinates[0]);
    const second = numberValue(coordinates[1]);
    if (first != null && second != null) {
      if (first >= 40 && first <= 45) { latitude = first; longitude = second; }
      else { longitude = first; latitude = second; }
    }
  }
  if ((latitude == null || longitude == null) && context.latlng) {
    latitude = numberValue(context.latlng.lat ?? context.latlng[0]);
    longitude = numberValue(context.latlng.lng ?? context.latlng.lon ?? context.latlng[1]);
  }
  if (latitude == null || longitude == null || latitude < 40 || latitude > 45 || longitude < 20 || longitude > 30) return null;

  const air = numberValue(pick(object, ['air', 'air_temperature', 'temperature_air', 'airTemp', 'temp_air', 'tair']));
  const surface = numberValue(pick(object, ['surface', 'road_temperature', 'temperature_road', 'surface_temperature', 'roadTemp', 'tsurface']));
  const humidity = numberValue(pick(object, ['humidity', 'relative_humidity', 'rh']));
  const pressure = numberValue(pick(object, ['pressure', 'atmospheric_pressure', 'barometer']));
  if (air == null && surface == null && humidity == null && pressure == null) return null;

  const stationId = clean(pick(object, ['station_id', 'stationId', 'external_id', 'id', 'code']) ?? `${latitude}|${longitude}`);
  const scp = clean(pick(object, ['scp', 'control_point', 'controlPoint']) ?? '');
  const name = clean(pick(object, ['name', 'station_name', 'stationName', 'title', 'location']) ?? (scp ? `Метеостанция ${scp}` : `Пътна метеостанция ${stationId}`));
  const measuredAt = isoUtc(pick(object, ['measured_at', 'measuredAt', 'timestamp', 'time', 'date', 'updated_at', 'datetime']));

  return {
    external_id: stationId,
    scp,
    name,
    latitude,
    longitude,
    temperature_air: air,
    temperature_road: surface,
    humidity,
    pressure,
    measured_at: measuredAt,
    source_extra: Object.fromEntries(Object.entries(object).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 80)),
  };
}

function addRecord(record) {
  if (!record) return;
  const key = `${record.external_id}|${record.latitude.toFixed(5)}|${record.longitude.toFixed(5)}`;
  records.set(key, record);
}

function walk(value, context = {}, depth = 0, seen = new WeakSet()) {
  if (depth > 18 || value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, context, depth + 1, seen);
    return;
  }
  addRecord(normalize(value, context));
  for (const child of Object.values(value)) walk(child, context, depth + 1, seen);
}

function parseBody(text, context = {}) {
  try {
    walk(JSON.parse(text), context);
    return true;
  } catch {
    return false;
  }
}

function extractUrls(text, baseUrl) {
  const result = new Set();
  const decoded = String(text || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+/gi,
    /(?:href|src)\s*=\s*["']([^"']+)["']/gi,
    /["']([^"']*(?:weather|meteo|meteor|mto)[^"']*)["']/gi,
    /["']([^"']+\.json(?:\?[^"']*)?)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const raw = match[1] || match[0];
      try {
        const url = new URL(raw, baseUrl).href;
        if (url.startsWith('http://') || url.startsWith('https://')) result.add(url);
      } catch {}
    }
  }
  return [...result];
}

function candidateScore(candidate) {
  const text = `${candidate.url} ${candidate.text || ''} ${candidate.context || ''}`.toLowerCase();
  let score = 0;
  if (/метеор|weather|meteor|пътно време|road weather/.test(text)) score += 100;
  if (/station_id|surface|humidity|pressure/.test(text)) score += 80;
  if (/\.json(?:\?|$)/.test(text)) score += 35;
  if (/data|download|open/.test(text)) score += 10;
  if (/traffic_pass|винет|tollproduct|check/.test(text)) score -= 80;
  return score;
}

await fs.mkdir(DIAG, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'bg-BG',
  timezoneId: 'Europe/Sofia',
  viewport: { width: 1440, height: 1000 },
  extraHTTPHeaders: { 'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.7' },
});

const page = await context.newPage();
const candidates = new Map();
const addCandidate = (url, meta = {}) => {
  try {
    const normalized = new URL(url, OPEN_DATA_PAGE).href;
    if (!/^https?:/i.test(normalized)) return;
    const existing = candidates.get(normalized) || { url: normalized, text: '', context: '', source: [] };
    existing.text += ` ${meta.text || ''}`;
    existing.context += ` ${meta.context || ''}`;
    existing.source.push(meta.source || 'unknown');
    candidates.set(normalized, existing);
  } catch {}
};

context.on('response', async (response) => {
  const url = response.url();
  const contentType = (await response.headerValue('content-type')) || '';
  if (response.status() < 200 || response.status() >= 400) return;
  if (/weather|meteo|meteor|mto|\.json(?:\?|$)/i.test(url)) addCandidate(url, { source: 'network' });
  if (!/json|text|javascript/i.test(contentType) && !/weather|meteo|meteor|mto|data|api/i.test(url)) return;
  try {
    const body = await response.body();
    if (body.length > 30 * 1024 * 1024) return;
    const text = body.toString('utf8');
    const before = records.size;
    parseBody(text, { url });
    if (records.size > before) diagnostics.matchedResponses.push({ url, added: records.size - before });
    for (const found of extractUrls(text, url)) addCandidate(found, { source: 'response-body', context: url });
  } catch {}
});

try {
  const response = await page.goto(OPEN_DATA_PAGE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  diagnostics.pageStatus = response?.status() || null;
  await page.waitForTimeout(5000);
  for (const label of ['Приемам', 'Съгласен съм', 'Разрешавам всички', 'Accept all']) {
    try {
      const button = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await button.isVisible({ timeout: 300 })) await button.click();
    } catch {}
  }
  await page.waitForTimeout(12000);

  const pageData = await page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    anchors: [...document.querySelectorAll('a[href]')].map((anchor) => ({
      href: anchor.href,
      text: (anchor.textContent || '').trim(),
      context: (anchor.parentElement?.textContent || '').trim().slice(0, 500),
    })),
    scripts: [...document.scripts].map((script) => ({ src: script.src, text: (script.textContent || '').slice(0, 2_000_000) })),
  }));

  for (const anchor of pageData.anchors) addCandidate(anchor.href, { ...anchor, source: 'anchor' });
  for (const script of pageData.scripts) {
    if (script.src) addCandidate(script.src, { source: 'script' });
    for (const found of extractUrls(script.text, OPEN_DATA_PAGE)) addCandidate(found, { source: 'inline-script' });
  }
  for (const found of extractUrls(pageData.html, OPEN_DATA_PAGE)) addCandidate(found, { source: 'html' });
  if (LEGACY_PAGE) addCandidate(LEGACY_PAGE, { source: 'legacy-env', text: 'weather' });
  await page.screenshot({ path: path.join(DIAG, 'bgtoll-open-data-weather.png'), fullPage: true });
} catch (error) {
  diagnostics.pageError = String(error?.message || error);
}

const queue = [...candidates.values()].map((candidate) => ({ ...candidate, score: candidateScore(candidate), depth: 0 }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 120);
const visited = new Set();

while (queue.length && records.size < MIN_RECORDS) {
  const candidate = queue.shift();
  if (!candidate || visited.has(candidate.url)) continue;
  visited.add(candidate.url);
  const requestInfo = { url: candidate.url, score: candidate.score, status: null, contentType: '', bytes: 0, added: 0 };
  try {
    const response = await context.request.get(candidate.url, {
      timeout: 90000,
      headers: { Referer: OPEN_DATA_PAGE, Accept: 'application/json,text/plain,text/html;q=0.8,*/*;q=0.5' },
    });
    requestInfo.status = response.status();
    requestInfo.contentType = response.headers()['content-type'] || '';
    if (!response.ok()) { diagnostics.requests.push(requestInfo); continue; }
    const body = await response.body();
    requestInfo.bytes = body.length;
    if (body.length > 50 * 1024 * 1024) { diagnostics.requests.push(requestInfo); continue; }
    const text = body.toString('utf8');
    const before = records.size;
    parseBody(text, { url: candidate.url });
    requestInfo.added = records.size - before;

    if (candidate.depth < 2 && /html|javascript|text/i.test(requestInfo.contentType)) {
      for (const found of extractUrls(text, candidate.url)) {
        if (visited.has(found)) continue;
        const next = { url: found, text: candidate.text, context: candidate.context, source: ['nested'], depth: candidate.depth + 1 };
        next.score = candidateScore(next) - next.depth * 5;
        if (next.score > 15) queue.push(next);
      }
      queue.sort((a, b) => b.score - a.score);
    }
  } catch (error) {
    requestInfo.error = String(error?.message || error);
  }
  diagnostics.requests.push(requestInfo);
}

diagnostics.candidateCount = candidates.size;
diagnostics.candidates = [...candidates.values()].map((candidate) => ({ ...candidate, score: candidateScore(candidate) })).sort((a, b) => b.score - a.score).slice(0, 80);
diagnostics.recordCount = records.size;
await fs.writeFile(path.join(DIAG, 'bgtoll-weather-diagnostics.json'), JSON.stringify(diagnostics, null, 2));

const list = [...records.values()].sort((a, b) => a.external_id.localeCompare(b.external_id, 'bg'));
if (list.length < MIN_RECORDS) {
  await browser.close();
  const top = diagnostics.requests.slice(0, 5).map((request) => `${request.status || 'ERR'} ${request.url}`).join('; ');
  throw new Error(`Не са открити валидни метеорологични записи от официалната страница за отворени данни. Кандидати: ${candidates.size}. Проверени: ${visited.size}. ${top}`);
}

const payload = {
  source: 'bgtoll_weather',
  schema_version: 1,
  collector_version: VERSION,
  collected_at: new Date().toISOString(),
  official_page: OPEN_DATA_PAGE,
  captured_from: diagnostics.matchedResponses[0]?.url || diagnostics.requests.find((request) => request.added > 0)?.url || OPEN_DATA_PAGE,
  records: list,
  diagnostics: {
    matched_responses: diagnostics.matchedResponses.slice(0, 20),
    successful_candidate: diagnostics.requests.find((request) => request.added > 0) || null,
    page_status: diagnostics.pageStatus,
  },
};

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
await browser.close();
console.log(JSON.stringify({ success: true, weatherRecords: list.length, capturedFrom: payload.captured_from }, null, 2));
