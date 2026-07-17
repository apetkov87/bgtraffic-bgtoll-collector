import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import AdmZip from 'adm-zip';

const OFFICIAL_DASHBOARD = process.env.MVR_ACCIDENTS_PAGE || 'https://www.mvr.bg/map/apps/dashboards/0b7065b1f1d34d7d8ad530c51434a9f0';
const OPEN_DATA_RESOURCE = process.env.MVR_OPEN_DATA_RESOURCE || 'https://testdata.egov.bg/data/resourceView/3182e4d4-479f-417f-bda0-4c00d3da2303';
const RESOURCE_ID = process.env.MVR_OPEN_DATA_RESOURCE_ID || '3182e4d4-479f-417f-bda0-4c00d3da2303';
const CHERNAPISTA_PAGE = process.env.CHERNAPISTA_DATA_PAGE || 'https://chernapista.com/data/';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_ACCIDENTS_OUTPUT || 'collector-output/accidents.json');
const DIAG = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');
const VERSION = '2.5.0';
const FROM_YEAR = Math.max(2024, Number(process.env.MVR_FROM_YEAR || 2024));
const MAX_RECORDS = Math.max(1000, Number(process.env.MVR_MAX_RECORDS || 50000));
const MIN_RECORDS = Math.max(1, Number(process.env.MVR_MIN_RECORDS || 10));
const WAIT_MS = Math.max(8000, Number(process.env.BGTRAFFIC_WAIT_MS || 30000));

const diagnostics = {
  officialDashboard: OFFICIAL_DASHBOARD,
  primaryResource: OPEN_DATA_RESOURCE,
  resourceId: RESOURCE_ID,
  fallbackPage: CHERNAPISTA_PAGE,
  fromYear: FROM_YEAR,
  pages: [],
  responses: [],
  candidates: [],
  attempts: [],
  selected: null,
  recordCount: 0,
};

const clean = (value) => String(value ?? '').replace(/^\uFEFF/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const canonical = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-zа-я0-9]+/gu, '');
const numberValue = (value) => {
  if (value == null || value === '') return null;
  const normalized = String(value).replace(/\u00a0/g, ' ').trim().replace(/\s+/g, '').replace(',', '.');
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
};
const integerValue = (value) => Math.max(0, Math.round(numberValue(value) || 0));
const validBulgarian = (longitude, latitude) => Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= 20 && longitude <= 30 && latitude >= 40 && latitude <= 45;

function stableId(parts) {
  return crypto.createHash('sha1').update(parts.map((value) => clean(value)).join('|')).digest('hex');
}

function parseDate(value, fallback = {}) {
  if (value !== null && value !== undefined && value !== '') {
    if (typeof value === 'number' || /^\d{10,13}$/.test(clean(value))) {
      let timestamp = Number(value);
      if (timestamp < 2e10) timestamp *= 1000;
      const date = new Date(timestamp);
      if (!Number.isNaN(date.getTime())) return date;
    }
    let raw = clean(value);
    const bg = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (bg) {
      const [, day, month, year, hour = '0', minute = '0', second = '0'] = bg;
      raw = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second.padStart(2, '0')}+03:00`;
    } else if (/^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
      raw = `${raw.replace(' ', 'T')}+03:00`;
    } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
      raw = `${raw}T00:00:00+03:00`;
    }
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const year = integerValue(fallback.year);
  if (year >= 1900 && year <= 2200) {
    const month = Math.min(12, Math.max(1, integerValue(fallback.month) || 1));
    const day = Math.min(31, Math.max(1, integerValue(fallback.day) || 1));
    const hour = Math.min(23, Math.max(0, integerValue(fallback.hour) || 0));
    return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+03:00`);
  }
  return null;
}

function keyMap(row) {
  const map = new Map();
  for (const [key, value] of Object.entries(row || {})) map.set(canonical(key), value);
  return map;
}

function valueByPatterns(map, patterns) {
  for (const pattern of patterns) {
    const target = canonical(pattern);
    if (map.has(target)) return map.get(target);
  }
  for (const [key, value] of map.entries()) {
    if (patterns.some((pattern) => key.includes(canonical(pattern)))) return value;
  }
  return null;
}

function normalizeRow(raw, sourceUrl = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const geometry = raw.geometry && typeof raw.geometry === 'object' ? raw.geometry : null;
  const properties = raw.properties && typeof raw.properties === 'object' ? raw.properties : null;
  const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : null;
  const row = { ...(properties || {}), ...(attributes || {}), ...raw };
  delete row.geometry;
  delete row.properties;
  delete row.attributes;
  const map = keyMap(row);

  let latitude = numberValue(valueByPatterns(map, ['Географска ширина', 'latitude', 'lat', 'ширина', 'y']));
  let longitude = numberValue(valueByPatterns(map, ['Географска дължина', 'longitude', 'lon', 'lng', 'дължина', 'x']));
  if (geometry?.coordinates && Array.isArray(geometry.coordinates)) {
    longitude ??= numberValue(geometry.coordinates[0]);
    latitude ??= numberValue(geometry.coordinates[1]);
  } else if (geometry) {
    longitude ??= numberValue(geometry.x);
    latitude ??= numberValue(geometry.y);
  }
  if (!validBulgarian(longitude, latitude) && validBulgarian(latitude, longitude)) [longitude, latitude] = [latitude, longitude];
  if (!validBulgarian(longitude, latitude)) return null;

  const yearValue = valueByPatterns(map, ['Година', 'year']);
  const occurred = parseDate(valueByPatterns(map, ['Дата и час на ПТП', 'Дата и час', 'datetime', 'occurred_at', 'date_time', 'timestamp', 'дата']), {
    year: yearValue,
    month: valueByPatterns(map, ['Месец', 'month']),
    day: valueByPatterns(map, ['Ден от месеца', 'day']),
    hour: valueByPatterns(map, ['Час', 'hour']),
  });
  if (!occurred || occurred.getFullYear() < FROM_YEAR) return null;

  const fatalities = integerValue(valueByPatterns(map, ['Брой загинали', 'загинали', 'fatalities', 'died', 'dead']));
  const injured = integerValue(valueByPatterns(map, ['Брой ранени', 'ранени', 'injured']));
  const participants = integerValue(valueByPatterns(map, ['Брой участници', 'участници', 'participants']));
  const accidentType = clean(valueByPatterns(map, ['Вид на ПТП', 'вид птп', 'accident type', 'type', 'category']) || 'Пътнотранспортно произшествие');
  const placeType = clean(valueByPatterns(map, ['Място на ПТП', 'място птп', 'place']) || '');
  const characteristicPlace = clean(valueByPatterns(map, ['Характерно място на ПТП', 'характерно място', 'characteristic place']) || '');
  const roadType = clean(valueByPatterns(map, ['Вид на пътя', 'път', 'road', 'route']) || '');
  const region = clean(valueByPatterns(map, ['Област', 'region', 'province']) || '');
  const municipality = clean(valueByPatterns(map, ['Община', 'municipality']) || '');
  const settlement = clean(valueByPatterns(map, ['Населено място', 'settlement', 'city', 'town', 'village']) || '');
  const severe = integerValue(valueByPatterns(map, ['Тежки ПТП', 'тежко птп', 'severe']));
  const objectId = valueByPatterns(map, ['OBJECTID', 'id', '_id', 'fid']);
  const location = [settlement, municipality, region, placeType].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index).join(', ') || 'Неуточнено място';
  const externalId = objectId ? `mvr-open:${objectId}` : `mvr-open:${stableId([occurred.toISOString(), latitude, longitude, accidentType, location])}`;

  const sourceExtra = {};
  for (const [key, value] of Object.entries(row)) {
    if (['string', 'number', 'boolean'].includes(typeof value) && Object.keys(sourceExtra).length < 120) sourceExtra[key] = value;
  }
  if (participants) sourceExtra.participants = participants;
  if (characteristicPlace) sourceExtra.characteristic_place = characteristicPlace;
  if (roadType) sourceExtra.road_type = roadType;
  if (severe) sourceExtra.severe = severe;

  return {
    external_id: externalId,
    occurred_at: occurred.toISOString(),
    latitude,
    longitude,
    location,
    municipality,
    region,
    severity: fatalities > 0 ? 'ПТП със загинали' : injured > 0 ? 'ПТП с ранени' : accidentType,
    injured,
    fatalities,
    road_code: roadType,
    description: [accidentType, characteristicPlace].filter(Boolean).join(' · '),
    source_extra: sourceExtra,
  };
}

function detectDelimiter(text) {
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((value) => value.trim()) || '';
  const counts = [',', ';', '\t', '|'].map((delimiter) => ({ delimiter, count: line.split(delimiter).length - 1 }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ',';
}

function parseDelimited(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', quoted = false;
  const value = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && value[index + 1] === '\n') index++;
      row.push(cell); cell = '';
      if (row.some((item) => clean(item) !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((item) => clean(item) !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header, index) => clean(header) || `column_${index + 1}`);
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

function accidentLikeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = canonical(Object.keys({ ...(value.properties || {}), ...(value.attributes || {}), ...value }).join(' '));
  return /(птп|произшеств|загинал|ранен|accident|fatalit|injured)/.test(keys) && /(ширина|дължина|latitude|longitude|lat|lon|geometry|x|y)/.test(keys);
}

function extractJsonRows(value, output = [], depth = 0, seen = new WeakSet()) {
  if (value == null || depth > 12) return output;
  if (typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      if (accidentLikeObject(child)) output.push(child);
      else extractJsonRows(child, output, depth + 1, seen);
    }
    return output;
  }
  if (accidentLikeObject(value)) output.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (/records|rows|features|items|data|result|results/i.test(key) || depth < 3) extractJsonRows(child, output, depth + 1, seen);
  }
  return output;
}

function addNormalizedRows(rawRows, sourceUrl, records) {
  let added = 0;
  for (const raw of rawRows) {
    const row = normalizeRow(raw, sourceUrl);
    if (!row) continue;
    const before = records.size;
    records.set(row.external_id, row);
    if (records.size > before) added++;
    if (records.size >= MAX_RECORDS) break;
  }
  return added;
}

function extensionOf(url) {
  try { return new URL(url).pathname.toLowerCase(); } catch { return String(url).toLowerCase(); }
}

async function parsePayload(buffer, contentType, sourceUrl, records) {
  if (!buffer?.length) return 0;
  const pathname = extensionOf(sourceUrl);
  const startsZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (startsZip || /zip/.test(contentType) || pathname.endsWith('.zip')) {
    let added = 0;
    try {
      const zip = new AdmZip(buffer);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !/\.(csv|json|geojson|txt)$/i.test(entry.entryName)) continue;
        added += await parsePayload(entry.getData(), entry.entryName.endsWith('.json') || entry.entryName.endsWith('.geojson') ? 'application/json' : 'text/csv', `${sourceUrl}#${entry.entryName}`, records);
        if (records.size >= MAX_RECORDS) break;
      }
    } catch (error) {
      diagnostics.attempts.push({ url: sourceUrl, parser: 'zip', error: String(error?.message || error) });
    }
    return added;
  }
  const text = buffer.toString('utf8');
  if (/json|geojson/i.test(contentType) || /\.(json|geojson)(?:$|\?)/i.test(pathname) || /^[\s\uFEFF]*[\[{]/.test(text)) {
    try {
      const json = JSON.parse(text.replace(/^\uFEFF/, ''));
      return addNormalizedRows(extractJsonRows(json), sourceUrl, records);
    } catch (error) {
      if (/json/i.test(contentType)) diagnostics.attempts.push({ url: sourceUrl, parser: 'json', error: String(error?.message || error) });
    }
  }
  if (/csv|text\/plain|octet-stream/i.test(contentType) || /\.(csv|txt)(?:$|\?)/i.test(pathname) || /Брой загинали|Географска ширина|Дата и час на ПТП/i.test(text.slice(0, 5000))) {
    try { return addNormalizedRows(parseDelimited(text), sourceUrl, records); }
    catch (error) { diagnostics.attempts.push({ url: sourceUrl, parser: 'csv', error: String(error?.message || error) }); }
  }
  return 0;
}

function candidateScore(url) {
  const value = url.toLowerCase();
  let score = 0;
  if (value.includes(RESOURCE_ID.toLowerCase())) score += 30;
  if (/trafficaccidents|accident|ptp|птп/.test(value)) score += 25;
  if (/\.csv(?:$|\?)/.test(value) || /format=csv|\/csv(?:$|\?)/.test(value)) score += 25;
  if (/\.json(?:$|\?)/.test(value) || /format=json|\/json(?:$|\?)/.test(value)) score += 20;
  if (/download|export|resource|datastore|api/.test(value)) score += 12;
  if (/\.zip(?:$|\?)/.test(value)) score += 10;
  if (/\.(png|jpg|jpeg|svg|css|js|woff|ico)(?:$|\?)/.test(value)) score -= 80;
  return score;
}

function addCandidate(set, raw, base) {
  if (!raw || typeof raw !== 'string') return;
  const decoded = raw.replace(/&amp;/g, '&').replace(/\\\//g, '/').trim();
  const pieces = [decoded];
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+/ig)) pieces.push(match[0]);
  for (const value of pieces) {
    try {
      const url = new URL(value, base).href.replace(/[),.;]+$/, '');
      if (candidateScore(url) > 0) set.add(url);
    } catch { /* ignore */ }
  }
}

async function collectFromPage(browser, pageUrl, label, records) {
  const context = await browser.newContext({
    locale: 'bg-BG',
    timezoneId: 'Europe/Sofia',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const candidates = new Set();
  const pending = [];
  let networkAdded = 0;

  page.on('response', (response) => {
    const task = (async () => {
      const url = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';
      addCandidate(candidates, url, pageUrl);
      if (status !== 200 || !/(json|csv|geojson|zip|octet-stream|text\/plain)/i.test(contentType + url)) return;
      try {
        const body = await response.body();
        const added = await parsePayload(body, contentType, url, records);
        if (added > 0) {
          networkAdded += added;
          diagnostics.responses.push({ label, url, status, contentType, added });
        }
      } catch (error) {
        diagnostics.responses.push({ label, url, status, contentType, error: String(error?.message || error) });
      }
    })();
    pending.push(task);
  });

  let status = null;
  let finalUrl = pageUrl;
  try {
    const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    status = response?.status() || null;
    await page.waitForTimeout(Math.min(WAIT_MS, 35000));
    finalUrl = page.url();
  } catch (error) {
    diagnostics.pages.push({ label, pageUrl, status, finalUrl, error: String(error?.message || error) });
  }

  try {
    await page.screenshot({ path: path.join(DIAG, `${label}.png`), fullPage: true });
  } catch { /* ignore */ }

  try {
    const discovered = await page.evaluate(() => {
      const values = [];
      for (const element of document.querySelectorAll('a,input,button,form,textarea,select,option')) {
        values.push(element.href || '', element.value || '', element.action || '', element.getAttribute('onclick') || '', element.getAttribute('data-url') || '', element.getAttribute('data-href') || '', element.getAttribute('data-download') || '', element.textContent || '');
        for (const attribute of element.attributes || []) values.push(attribute.value || '');
      }
      values.push(document.documentElement.outerHTML);
      return values.filter(Boolean);
    });
    for (const value of discovered) addCandidate(candidates, value, finalUrl);
  } catch (error) {
    diagnostics.attempts.push({ label, stage: 'dom-discovery', error: String(error?.message || error) });
  }

  const base = new URL(finalUrl);
  const commonPaths = [
    `/data/resourceDownload/${RESOURCE_ID}/csv`,
    `/data/resourceDownload/${RESOURCE_ID}?format=csv`,
    `/data/resourceDownload/${RESOURCE_ID}/json`,
    `/data/resourceDownload/${RESOURCE_ID}?format=json`,
    `/data/download/${RESOURCE_ID}?format=csv`,
    `/data/download/${RESOURCE_ID}?format=json`,
    `/data/resource/${RESOURCE_ID}/download?format=csv`,
    `/data/resource/${RESOURCE_ID}/download?format=json`,
    `/api/3/action/datastore_search?resource_id=${RESOURCE_ID}&limit=${MAX_RECORDS}`,
    `/api/action/datastore_search?resource_id=${RESOURCE_ID}&limit=${MAX_RECORDS}`,
    `/api/resource/${RESOURCE_ID}?format=json&limit=${MAX_RECORDS}`,
    `/api/data/${RESOURCE_ID}?format=json&limit=${MAX_RECORDS}`,
  ];
  if (base.hostname.includes('egov.bg')) for (const commonPath of commonPaths) addCandidate(candidates, commonPath, `${base.protocol}//${base.host}`);

  const ordered = [...candidates].map((url) => ({ url, score: candidateScore(url) })).sort((a, b) => b.score - a.score).slice(0, 100);
  diagnostics.candidates.push(...ordered.map((item) => ({ label, ...item })));

  for (const { url, score } of ordered) {
    if (records.size >= MIN_RECORDS && score < 25) break;
    try {
      const response = await context.request.get(url, {
        timeout: 90000,
        headers: { Accept: 'application/json,text/csv,text/plain,application/zip,application/octet-stream,*/*', Referer: finalUrl },
      });
      const contentType = response.headers()['content-type'] || '';
      const body = await response.body();
      const added = response.ok() ? await parsePayload(body, contentType, url, records) : 0;
      diagnostics.attempts.push({ label, url, status: response.status(), contentType, bytes: body.length, added });
      if (added > 0) diagnostics.selected = { label, url, contentType };
    } catch (error) {
      diagnostics.attempts.push({ label, url, error: String(error?.message || error) });
    }
    if (records.size >= MAX_RECORDS) break;
  }

  await Promise.allSettled(pending);
  diagnostics.pages.push({ label, pageUrl, status, finalUrl, networkAdded, records: records.size, candidates: ordered.length });
  await context.close();
}

await fs.mkdir(DIAG, { recursive: true });
const records = new Map();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await collectFromPage(browser, OPEN_DATA_RESOURCE, 'mvr-open-data', records);
  if (records.size < MIN_RECORDS) await collectFromPage(browser, CHERNAPISTA_PAGE, 'chernapista-data', records);
  await browser.close();
  browser = null;

  const list = [...records.values()].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, MAX_RECORDS);
  diagnostics.recordCount = list.length;
  await fs.writeFile(path.join(DIAG, 'mvr-accidents-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  if (list.length < MIN_RECORDS) throw new Error(`Не са намерени достатъчно валидни ПТП записи. Получени: ${list.length}. Проверени са официалният ресурс на Портала за отворени данни и резервният отворен набор.`);

  const payload = {
    source: 'mvr_accidents',
    schema_version: 1,
    collector_version: VERSION,
    collected_at: new Date().toISOString(),
    official_page: OFFICIAL_DASHBOARD,
    captured_from: diagnostics.selected?.url || OPEN_DATA_RESOURCE,
    source_dataset: OPEN_DATA_RESOURCE,
    source_license: 'CC0',
    records: list,
    diagnostics: {
      selected: diagnostics.selected,
      checked_pages: diagnostics.pages.length,
      candidate_urls: diagnostics.candidates.length,
      parsed_responses: diagnostics.responses.length,
    },
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ success: true, accidentRecords: list.length, capturedFrom: payload.captured_from, fromYear: FROM_YEAR }, null, 2));
} catch (error) {
  if (browser) await browser.close().catch(() => {});
  diagnostics.error = String(error?.message || error);
  diagnostics.recordCount = records.size;
  await fs.writeFile(path.join(DIAG, 'mvr-accidents-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  throw error;
}
