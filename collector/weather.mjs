import { chromium } from 'playwright';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';

const OPEN_DATA_PAGE = process.env.BGTOLL_OPEN_DATA_PAGE || 'https://bgtoll.bg/otvoreni-danni';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_WEATHER_OUTPUT || 'collector-output/weather.json');
const DIAG = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');
const VERSION = '2.2.0';
const MIN_RECORDS = Math.max(1, Number(process.env.BGTRAFFIC_WEATHER_MIN_RECORDS || 5));
const MAX_BODY = 80 * 1024 * 1024;

const records = new Map();
const candidates = new Map();
const pendingResponses = new Set();
const downloadedFiles = [];
const diagnostics = {
  openDataPage: OPEN_DATA_PAGE,
  pageUrl: null,
  pageStatus: null,
  pageTextSample: '',
  pageError: null,
  challengeDetected: false,
  clickedWeatherElements: [],
  candidateCount: 0,
  candidates: [],
  requests: [],
  downloads: [],
  matchedResponses: [],
  recordCount: 0,
};

const clean = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const normalizedKey = (value) => clean(value).toLowerCase().replace(/[^a-zа-я0-9]+/gu, '');
const numberValue = (value) => {
  if (typeof value === 'string') value = value.trim().replace(/\s+/g, '').replace(',', '.');
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const pick = (object, keys) => {
  if (!object || typeof object !== 'object') return null;
  const entries = Object.keys(object);
  for (const wanted of keys) {
    const exact = entries.find((entry) => normalizedKey(entry) === normalizedKey(wanted));
    if (exact && object[exact] !== '' && object[exact] != null) return object[exact];
  }
  for (const wanted of keys) {
    const partial = entries.find((entry) => normalizedKey(entry).includes(normalizedKey(wanted)));
    if (partial && object[partial] !== '' && object[partial] != null) return object[partial];
  }
  return null;
};

function isoUtc(value) {
  if (value == null || value === '') return new Date().toISOString();
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    let timestamp = Number(value);
    if (timestamp < 2e10) timestamp *= 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  let raw = clean(value);
  if (/^\d{1,2}\.\d{1,2}\.\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(raw)) {
    const [datePart, timePart = '00:00:00'] = raw.split(/\s+/);
    const [day, month, year] = datePart.split('.');
    raw = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${timePart.padEnd(8, ':00')}+03:00`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    raw = `${raw.replace(' ', 'T')}Z`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function toWgs84(x, y) {
  let longitude = numberValue(x);
  let latitude = numberValue(y);
  if (longitude == null || latitude == null) return [null, null];
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    longitude = longitude / 20037508.34 * 180;
    latitude = latitude / 20037508.34 * 180;
    latitude = 180 / Math.PI * (2 * Math.atan(Math.exp(latitude * Math.PI / 180)) - Math.PI / 2);
  }
  return [latitude, longitude];
}

function getCoordinates(object, context = {}) {
  let latitude = numberValue(pick(object, ['lat', 'latitude', 'geographic_latitude', 'ширина', 'y']));
  let longitude = numberValue(pick(object, ['lon', 'lng', 'longitude', 'geographic_longitude', 'дължина', 'x']));
  const geometry = pick(object, ['geometry', 'geom']);
  if ((latitude == null || longitude == null) && geometry && typeof geometry === 'object') {
    [latitude, longitude] = toWgs84(geometry.x ?? geometry.longitude ?? geometry.lng, geometry.y ?? geometry.latitude ?? geometry.lat);
  }
  const coordinates = pick(object, ['coordinates', 'coordinate', 'latlng', 'position']);
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
  return [latitude, longitude];
}

function normalize(object, context = {}) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const attributes = object.attributes && typeof object.attributes === 'object' ? object.attributes : object.properties && typeof object.properties === 'object' ? object.properties : object;
  const merged = { ...attributes };
  if (object.geometry && !merged.geometry) merged.geometry = object.geometry;
  const [latitude, longitude] = getCoordinates(merged, context);
  if (latitude == null || longitude == null || latitude < 40 || latitude > 45 || longitude < 20 || longitude > 30) return null;

  const air = numberValue(pick(merged, [
    'air', 'air_temperature', 'temperature_air', 'airTemp', 'temp_air', 'tair', 'airtemperature',
    'температуравъздух', 'температуранавъздуха', 'темпвъздух',
  ]));
  const surface = numberValue(pick(merged, [
    'surface', 'road_temperature', 'temperature_road', 'surface_temperature', 'roadTemp', 'tsurface',
    'roadsurfacetemperature', 'pavement_temperature', 'температуранастилка', 'температуранапътнатанастилка',
  ]));
  const humidity = numberValue(pick(merged, ['humidity', 'relative_humidity', 'rh', 'влажност', 'относителнавлажност']));
  const pressure = numberValue(pick(merged, ['pressure', 'atmospheric_pressure', 'barometer', 'налягане', 'атмосферноналягане']));
  if (air == null && surface == null && humidity == null && pressure == null) return null;

  const stationId = clean(pick(merged, ['station_id', 'stationId', 'external_id', 'stationcode', 'id', 'code', 'номерстанция']) ?? `${latitude.toFixed(6)}|${longitude.toFixed(6)}`);
  const scp = clean(pick(merged, ['scp', 'control_point', 'controlPoint', 'контролнаточка']) ?? '');
  const name = clean(pick(merged, ['name', 'station_name', 'stationName', 'title', 'location', 'наименование', 'местоположение']) ?? (scp ? `Метеостанция ${scp}` : `Пътна метеостанция ${stationId}`));
  const measuredAt = isoUtc(pick(merged, ['measured_at', 'measuredAt', 'timestamp', 'time', 'date', 'updated_at', 'datetime', 'дата', 'час']));

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
    source_extra: Object.fromEntries(Object.entries(merged).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 100)),
  };
}

function addRecord(record) {
  if (!record) return;
  const key = `${record.external_id}|${record.latitude.toFixed(5)}|${record.longitude.toFixed(5)}`;
  const previous = records.get(key);
  if (!previous || Date.parse(record.measured_at) >= Date.parse(previous.measured_at)) records.set(key, record);
}

function walk(value, context = {}, depth = 0, seen = new WeakSet()) {
  if (depth > 20 || value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, context, depth + 1, seen);
    return;
  }
  addRecord(normalize(value, context));
  for (const child of Object.values(value)) walk(child, context, depth + 1, seen);
}

function parseDelimited(text, context = {}) {
  const sample = String(text || '').replace(/^\uFEFF/, '');
  const lines = sample.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return false;
  const delimiter = [';', '\t', ','].sort((a, b) => (lines[0].split(b).length) - (lines[0].split(a).length))[0];
  if (lines[0].split(delimiter).length < 3) return false;
  const parseLine = (line) => {
    const result = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i++; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) { result.push(current); current = ''; }
      else current += char;
    }
    result.push(current);
    return result.map((value) => value.trim());
  };
  const headers = parseLine(lines[0]);
  let parsed = 0;
  for (const line of lines.slice(1, 200000)) {
    const values = parseLine(line);
    if (values.length < Math.min(3, headers.length)) continue;
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
    const before = records.size;
    addRecord(normalize(row, context));
    if (records.size > before) parsed++;
  }
  return parsed > 0;
}

function parseBuffer(buffer, context = {}) {
  if (!buffer || !buffer.length) return false;
  const before = records.size;
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const zip = new AdmZip(buffer);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || entry.header.size > MAX_BODY) continue;
        if (!/\.(?:json|geojson|csv|txt)$/i.test(entry.entryName)) continue;
        parseBuffer(entry.getData(), { ...context, entry: entry.entryName });
      }
      return records.size > before;
    } catch {}
  }
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return false;
  try {
    walk(JSON.parse(text), context);
  } catch {
    parseDelimited(text, context);
  }
  return records.size > before;
}

function safeCandidateUrl(raw, baseUrl = OPEN_DATA_PAGE) {
  try {
    const url = new URL(raw, baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    const value = url.href.replace(/&amp;/g, '&');
    if (value.length > 1500 || /w3\.org|doubleclick|facebook|google-analytics|recaptcha/i.test(value)) return null;
    if ((value.match(/!/g) || []).length > 3 || /[{}<>`]/.test(value)) return null;
    const useful = /weather|meteo|meteor|mto|station|open.?data|download|\.json(?:\?|$)|\.csv(?:\?|$)|\.zip(?:\?|$)/i.test(value);
    return useful ? value : null;
  } catch { return null; }
}

function addCandidate(raw, meta = {}) {
  const url = safeCandidateUrl(raw, meta.baseUrl || OPEN_DATA_PAGE);
  if (!url) return;
  const existing = candidates.get(url) || { url, text: '', context: '', sources: new Set() };
  existing.text += ` ${clean(meta.text || '')}`;
  existing.context += ` ${clean(meta.context || '')}`;
  existing.sources.add(meta.source || 'unknown');
  candidates.set(url, existing);
}

function candidateScore(candidate) {
  const text = `${candidate.url} ${candidate.text || ''} ${candidate.context || ''}`.toLowerCase();
  let score = 0;
  if (/метеор|weather|meteor|пътно време|road weather|метео/.test(text)) score += 120;
  if (/station_id|surface|humidity|pressure|температура|влажност/.test(text)) score += 90;
  if (/\.json(?:\?|$)/.test(text)) score += 45;
  if (/\.csv(?:\?|$)|\.zip(?:\?|$)/.test(text)) score += 35;
  if (/data|download|open/.test(text)) score += 10;
  if (/traffic_pass|винет|tollproduct|check/.test(text)) score -= 80;
  return score;
}

function extractUsefulUrls(text, baseUrl) {
  const result = new Set();
  const decoded = String(text || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+/gi,
    /(?:href|src|url|downloadUrl|fileUrl)\s*[:=]\s*["']([^"']+)["']/gi,
    /["']([^"']*(?:weather|meteo|meteor|mto|station|open.?data|download)[^"']*)["']/gi,
    /["']([^"']+\.(?:json|geojson|csv|zip)(?:\?[^"']*)?)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const url = safeCandidateUrl(match[1] || match[0], baseUrl);
      if (url) result.add(url);
    }
  }
  return [...result];
}

await fs.mkdir(DIAG, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'bg-BG',
  timezoneId: 'Europe/Sofia',
  viewport: { width: 1440, height: 1100 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.7', DNT: '1' },
  acceptDownloads: true,
});

async function inspectResponse(response) {
  const url = response.url();
  const request = response.request();
  const contentType = (await response.headerValue('content-type')) || '';
  if (response.status() < 200 || response.status() >= 400) return;
  const interesting = /weather|meteo|meteor|mto|station|open.?data|download|json|csv|zip|octet-stream/i.test(`${url} ${contentType}`)
    || ['xhr', 'fetch'].includes(request.resourceType());
  if (!interesting) return;
  addCandidate(url, { source: 'network' });
  try {
    const body = await response.body();
    if (!body.length || body.length > MAX_BODY) return;
    const before = records.size;
    parseBuffer(body, { url });
    const added = records.size - before;
    if (added > 0) diagnostics.matchedResponses.push({ url, status: response.status(), contentType, added });
    if (/text|json|javascript|html/i.test(contentType)) {
      for (const found of extractUsefulUrls(body.toString('utf8'), url)) addCandidate(found, { source: 'response-body', baseUrl: url });
    }
  } catch {}
}

context.on('response', (response) => {
  const task = inspectResponse(response).finally(() => pendingResponses.delete(task));
  pendingResponses.add(task);
});
context.on('page', (newPage) => {
  newPage.on('download', async (download) => {
    const filename = download.suggestedFilename();
    const target = path.join(DIAG, `weather-download-${Date.now()}-${filename}`);
    try { await download.saveAs(target); downloadedFiles.push(target); } catch {}
  });
});

const page = await context.newPage();
page.on('download', async (download) => {
  const filename = download.suggestedFilename();
  const target = path.join(DIAG, `weather-download-${Date.now()}-${filename}`);
  try { await download.saveAs(target); downloadedFiles.push(target); } catch {}
});

async function acceptCookies(targetPage) {
  for (const label of ['Приемам', 'Съгласен съм', 'Разрешавам всички', 'Accept all', 'Accept']) {
    try {
      const button = targetPage.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await button.isVisible({ timeout: 500 })) await button.click();
    } catch {}
  }
}

async function pageSnapshot(targetPage) {
  return targetPage.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 20000),
    html: document.documentElement.outerHTML.slice(0, 5_000_000),
    links: [...document.querySelectorAll('a[href]')].map((element) => ({
      href: element.href,
      text: (element.textContent || '').trim(),
      context: (element.closest('section,article,div,li')?.textContent || '').trim().slice(0, 700),
    })),
    weatherElements: [...document.querySelectorAll('a,button,[role="button"],[data-url],[data-href]')]
      .map((element, index) => ({
        index,
        tag: element.tagName,
        text: (element.textContent || '').trim().slice(0, 500),
        href: element.href || element.getAttribute('data-url') || element.getAttribute('data-href') || '',
        onclick: element.getAttribute('onclick') || '',
      }))
      .filter((item) => /метеор|време|weather|meteo|meteor|станци/i.test(`${item.text} ${item.href} ${item.onclick}`))
      .slice(0, 100),
    resources: performance.getEntriesByType('resource').map((entry) => entry.name).slice(-1000),
  }));
}

try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = attempt === 1
      ? await page.goto(OPEN_DATA_PAGE, { waitUntil: 'domcontentloaded', timeout: 120000 })
      : await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    diagnostics.pageStatus = response?.status() || null;
    await page.waitForTimeout(5000);
    await acceptCookies(page);
    await page.waitForTimeout(attempt === 1 ? 18000 : 12000);
    const snapshot = await pageSnapshot(page);
    diagnostics.pageUrl = snapshot.url;
    diagnostics.pageTextSample = snapshot.text.slice(0, 2000);
    const challenge = /access denied|imunify|checking your browser|verify you are human|bot.?protection|captcha/i.test(snapshot.text)
      || (/refresh-expired|upgradeCompletedCount|cData/i.test(snapshot.html) && snapshot.text.length < 3000);
    diagnostics.challengeDetected = diagnostics.challengeDetected || challenge;
    if (!challenge) {
      for (const link of snapshot.links) addCandidate(link.href, { ...link, source: 'anchor', baseUrl: snapshot.url });
      for (const resource of snapshot.resources) addCandidate(resource, { source: 'performance', baseUrl: snapshot.url });
      for (const found of extractUsefulUrls(snapshot.html, snapshot.url)) addCandidate(found, { source: 'html', baseUrl: snapshot.url });

      for (const item of snapshot.weatherElements.slice(0, 20)) {
        if (item.href) addCandidate(item.href, { source: 'weather-element', text: item.text, context: item.onclick, baseUrl: snapshot.url });
      }

      // Open/click the weather section because some download links are rendered only after interaction.
      for (const frame of page.frames()) {
        const locators = [
          frame.getByText(/метеорологични данни|пътна метеорология|метеорологични станции|road weather|weather stations/i),
          frame.locator('a,button,[role="button"]').filter({ hasText: /метеор|пътно време|weather|meteo/i }),
        ];
        for (const locator of locators) {
          const count = Math.min(await locator.count().catch(() => 0), 10);
          for (let index = 0; index < count; index++) {
            const element = locator.nth(index);
            try {
              if (!(await element.isVisible({ timeout: 300 }))) continue;
              const text = clean(await element.textContent());
              diagnostics.clickedWeatherElements.push(text.slice(0, 300));
              await element.scrollIntoViewIfNeeded();
              await element.click({ timeout: 3000 });
              await page.waitForTimeout(2500);
            } catch {}
          }
        }
      }
      await page.waitForTimeout(12000);
      const after = await pageSnapshot(page);
      for (const link of after.links) addCandidate(link.href, { ...link, source: 'anchor-after-click', baseUrl: after.url });
      for (const resource of after.resources) addCandidate(resource, { source: 'performance-after-click', baseUrl: after.url });
      for (const found of extractUsefulUrls(after.html, after.url)) addCandidate(found, { source: 'html-after-click', baseUrl: after.url });
      break;
    }
  }
  await Promise.allSettled([...pendingResponses]);
  await page.screenshot({ path: path.join(DIAG, 'bgtoll-open-data-weather.png'), fullPage: true });
} catch (error) {
  diagnostics.pageError = String(error?.message || error);
}

// Strict, deterministic route candidates. They are harmless 404s when unavailable and are never accepted without valid weather fields.
const origin = new URL(OPEN_DATA_PAGE).origin;
for (const route of [
  '/index.php/weather/data', '/index.php/road_weather/data', '/index.php/weather_stations/data',
  '/index.php/meteorological/data', '/index.php/meteorological_stations/data', '/index.php/meteo/data',
  '/weather/data', '/road_weather/data', '/meteo/data',
]) addCandidate(`${origin}${route}`, { source: 'known-route', text: 'weather station data' });

for (const downloaded of downloadedFiles) {
  try {
    const buffer = await fs.readFile(downloaded);
    const before = records.size;
    parseBuffer(buffer, { file: downloaded });
    diagnostics.downloads.push({ file: path.basename(downloaded), bytes: buffer.length, added: records.size - before });
  } catch (error) {
    diagnostics.downloads.push({ file: path.basename(downloaded), error: String(error?.message || error) });
  }
}

const queue = [...candidates.values()]
  .map((candidate) => ({ ...candidate, sources: [...candidate.sources], score: candidateScore(candidate) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 100);

for (const candidate of queue) {
  if (records.size >= MIN_RECORDS) break;
  const requestInfo = { url: candidate.url, score: candidate.score, status: null, contentType: '', bytes: 0, added: 0 };
  try {
    const response = await context.request.get(candidate.url, {
      timeout: 90000,
      headers: { Referer: diagnostics.pageUrl || OPEN_DATA_PAGE, Accept: 'application/json,text/csv,application/zip,text/plain,*/*;q=0.5' },
    });
    requestInfo.status = response.status();
    requestInfo.contentType = response.headers()['content-type'] || '';
    if (!response.ok()) { diagnostics.requests.push(requestInfo); continue; }
    const body = await response.body();
    requestInfo.bytes = body.length;
    if (body.length > MAX_BODY) { diagnostics.requests.push(requestInfo); continue; }
    const before = records.size;
    parseBuffer(body, { url: candidate.url });
    requestInfo.added = records.size - before;
  } catch (error) {
    requestInfo.error = String(error?.message || error);
  }
  diagnostics.requests.push(requestInfo);
}

const list = [...records.values()].sort((a, b) => a.external_id.localeCompare(b.external_id, 'bg'));
diagnostics.candidateCount = candidates.size;
diagnostics.candidates = queue.slice(0, 80);
diagnostics.recordCount = list.length;
await fs.writeFile(path.join(DIAG, 'bgtoll-weather-diagnostics.json'), JSON.stringify(diagnostics, null, 2));

if (list.length < MIN_RECORDS) {
  await browser.close();
  const useful = diagnostics.requests.filter((item) => item.status && item.status !== 404).slice(0, 6).map((item) => `${item.status} ${item.url}`).join('; ');
  throw new Error(`Не са открити валидни метеостанции. Страницата: HTTP ${diagnostics.pageStatus ?? '—'}; защита: ${diagnostics.challengeDetected ? 'да' : 'не'}; смислени кандидати: ${candidates.size}; записи: ${list.length}.${useful ? ` Проверени: ${useful}` : ''}`);
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
    challenge_detected: diagnostics.challengeDetected,
    clicked_elements: diagnostics.clickedWeatherElements.slice(0, 20),
  },
};

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
await browser.close();
console.log(JSON.stringify({ success: true, weatherRecords: list.length, capturedFrom: payload.captured_from }, null, 2));
