import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const OFFICIAL_PAGE = process.env.BGTOLL_TRAFFIC_PAGE || 'https://bgtoll.bg/traffic_passes/';
const DELIVERY_MODE = process.env.BGTRAFFIC_DELIVERY_MODE || 'github-file';
const INGEST_URL = process.env.BGTRAFFIC_INGEST_URL || '';
const INGEST_TOKEN = process.env.BGTRAFFIC_INGEST_TOKEN || '';
const OUTPUT_FILE = path.resolve(process.env.BGTRAFFIC_OUTPUT_FILE || 'collector-output/latest.json');
const COLLECTOR_VERSION = '1.1.0';
const MIN_RECORDS = Number(process.env.BGTRAFFIC_MIN_RECORDS || 10);
const WAIT_MS = Number(process.env.BGTRAFFIC_WAIT_MS || 30000);
const diagnosticsDir = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');

if (DELIVERY_MODE === 'http' && (!INGEST_URL || !INGEST_TOKEN)) {
  throw new Error('При BGTRAFFIC_DELIVERY_MODE=http липсват BGTRAFFIC_INGEST_URL или BGTRAFFIC_INGEST_TOKEN.');
}

const diagnostics = {
  officialPage: OFFICIAL_PAGE,
  startedAt: new Date().toISOString(),
  responseCount: 0,
  inspectedResponses: 0,
  matchedResponses: [],
  failedRequests: [],
  webSocketFrames: 0,
  leafletObjects: 0,
  inlineCandidates: 0,
};

const records = new Map();
const pendingResponses = new Set();

function pick(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== '' && object[key] !== null && object[key] !== undefined) {
      return object[key];
    }
    const actual = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual && object[actual] !== '' && object[actual] !== null && object[actual] !== undefined) return object[actual];
  }
  return undefined;
}

function numeric(value) {
  if (typeof value === 'string') value = value.trim().replace(',', '.').replace(/\s+/g, '');
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = numeric(value);
  if (number === null || number < 0) return null;
  return Math.round(number);
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function directionLabel(value) {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return '';
  if (['1', 'up', 'increasing'].includes(raw) || /нараства/.test(raw)) return 'Нарастващ километраж';
  if (['2', 'down', 'decreasing'].includes(raw) || /намалява/.test(raw)) return 'Намаляващ километраж';
  return cleanText(value);
}

function roadFromName(name) {
  const motorway = name.match(/АМ\s*[„"]([^”“"]+)[”“"]/u);
  if (motorway) return `АМ ${motorway[1].trim()}`;
  const road = name.match(/\b(A-?\d+|I{1,3}-?\d+|E-?\d+)\b/ui);
  return road ? road[1].toUpperCase() : '';
}

function normalizeObject(object, context = {}) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;

  let lat = numeric(pick(object, ['lat', 'latitude', 'Latitude', 'y']));
  let lon = numeric(pick(object, ['lon', 'lng', 'longitude', 'Longitude', 'x']));
  const coordinates = pick(object, ['coordinates', 'coord', 'position', 'latlng']);
  if ((!lat || !lon) && Array.isArray(coordinates) && coordinates.length >= 2) {
    const first = numeric(coordinates[0]);
    const second = numeric(coordinates[1]);
    if (first !== null && second !== null) {
      if (first > 40 && first < 45) { lat = first; lon = second; }
      else { lon = first; lat = second; }
    }
  }
  if ((!lat || !lon) && context.latlng) {
    lat = numeric(context.latlng.lat ?? context.latlng[0]);
    lon = numeric(context.latlng.lng ?? context.latlng.lon ?? context.latlng[1]);
  }
  if (lat === null || lon === null || lat < 40 || lat > 45 || lon < 20 || lon > 30) return null;

  let count15 = integer(pick(object, ['count15min', 'count_15m', 'count15', 'vehicles15', 'last15Minutes']));
  let count60 = integer(pick(object, ['count1Hour', 'count_60m', 'count60', 'vehicles60', 'lastHour']));

  const popup = cleanText(context.popup || context.tooltip || pick(object, ['popup', 'tooltip', 'content', 'html', 'description']));
  if (count15 === null && popup) {
    const match = popup.match(/(?:15\s*мин(?:ути)?|15\s*min)[^0-9]{0,40}([0-9][0-9\s]*)/iu);
    if (match) count15 = integer(match[1]);
  }
  if (count60 === null && popup) {
    const match = popup.match(/(?:1\s*час|60\s*мин(?:ути)?|1\s*hour)[^0-9]{0,40}([0-9][0-9\s]*)/iu);
    if (match) count60 = integer(match[1]);
  }
  if (count15 === null || count60 === null) return null;

  const scp = cleanText(pick(object, ['scp', 'external_id', 'externalId', 'stationCode', 'code', 'id']) ?? context.scp);
  if (!scp) return null;

  let name = cleanText(pick(object, ['name', 'nameBG', 'location_name', 'locationName', 'title', 'stationName']) ?? context.name);
  if (!name && popup) {
    name = popup
      .replace(/(?:15\s*мин(?:ути)?|15\s*min).*$/iu, '')
      .replace(/(?:1\s*час|60\s*мин(?:ути)?|1\s*hour).*$/iu, '')
      .trim();
  }
  if (!name || /draw\s*helper|leaflet|geometry\s*helper/i.test(name)) return null;

  const explicitDirectionCode = cleanText(pick(object, ['directionMarker', 'direction_code', 'directionCode', 'dir', 'direction_id']) ?? context.directionCode);
  const scpDirectionCode = !explicitDirectionCode && /^[0-9]+$/.test(scp) && /[12]$/.test(scp) ? scp.slice(-1) : '';
  const directionCode = explicitDirectionCode || scpDirectionCode;
  const direction = directionLabel(pick(object, ['direction', 'directionName', 'direction_name']) ?? context.direction ?? directionCode) || 'Посоката не е публикувана';
  const externalId = explicitDirectionCode && !scp.endsWith(`:${explicitDirectionCode}`) ? `${scp}:${explicitDirectionCode}` : scp;
  const measuredAt = cleanText(pick(object, ['measured_at', 'measuredAt', 'timestamp', 'date', 'updated_at', 'updatedAt'])) || new Date().toISOString();
  const roadCode = cleanText(pick(object, ['road_code', 'roadCode', 'road', 'route'])) || roadFromName(name);

  return {
    external_id: externalId,
    scp,
    name,
    road_code: roadCode,
    direction,
    direction_code: directionCode,
    latitude: lat,
    longitude: lon,
    count_15m: count15,
    count_60m: count60,
    measured_at: measuredAt,
    captured_from: context.url || OFFICIAL_PAGE,
  };
}

function addRecord(record) {
  if (!record) return;
  const key = `${record.external_id}|${record.latitude.toFixed(6)}|${record.longitude.toFixed(6)}`;
  const previous = records.get(key);
  if (!previous || Date.parse(record.measured_at) >= Date.parse(previous.measured_at)) records.set(key, record);
}

function walk(value, context = {}, depth = 0, seen = new WeakSet()) {
  if (depth > 14 || value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) walk(item, context, depth + 1, seen);
    return;
  }

  addRecord(normalizeObject(value, context));
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    walk(child, context, depth + 1, seen);
  }
}

function parseText(text, context = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  try {
    const data = JSON.parse(trimmed);
    walk(data, context);
    return;
  } catch {}

  // Handles JSON embedded as a quoted JSON.parse("...") argument.
  const patterns = [
    /JSON\.parse\(\s*'(.*?)'\s*\)/gs,
    /JSON\.parse\(\s*"(.*?)"\s*\)/gs,
  ];
  for (const pattern of patterns) {
    for (const match of trimmed.matchAll(pattern)) {
      try {
        const decoded = JSON.parse(`"${match[1].replace(/"/g, '\\"')}"`);
        walk(JSON.parse(decoded), context);
      } catch {}
    }
  }
}

async function inspectResponse(response) {
  diagnostics.responseCount++;
  const request = response.request();
  const resourceType = request.resourceType();
  const url = response.url();
  const contentType = (await response.headerValue('content-type')) || '';
  const interesting = ['xhr', 'fetch', 'document', 'script'].includes(resourceType)
    || /json|javascript|text|octet-stream/i.test(contentType)
    || /traffic|pass|toll|data|api|ajax|map/i.test(url);
  if (!interesting || response.status() < 200 || response.status() >= 400) return;

  diagnostics.inspectedResponses++;
  try {
    const body = await response.body();
    if (!body || body.length > 30 * 1024 * 1024) return;
    const text = body.toString('utf8');
    const before = records.size;
    if (/count15min|count1Hour|count_15m|count_60m/i.test(text) || /json/i.test(contentType)) {
      parseText(text, { url });
    }
    if (records.size > before) {
      diagnostics.matchedResponses.push({ url, status: response.status(), resourceType, contentType, added: records.size - before });
    }
  } catch (error) {
    // Some opaque or streaming responses do not expose a body; they are safely skipped.
  }
}

await fs.mkdir(diagnosticsDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'bg-BG',
  timezoneId: 'Europe/Sofia',
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  extraHTTPHeaders: {
    'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.7',
    'DNT': '1',
  },
});

await context.addInitScript(() => {
  window.__bgtrafficLeaflet = [];
  const serializeContent = (content) => {
    if (typeof content === 'string') return content;
    if (content && typeof content.textContent === 'string') return content.textContent;
    try { return JSON.stringify(content); } catch { return ''; }
  };
  const install = () => {
    const L = window.L;
    if (!L || L.__bgtrafficWrapped) return;
    L.__bgtrafficWrapped = true;
    for (const method of ['geoJSON', 'geoJson']) {
      if (typeof L[method] !== 'function') continue;
      const original = L[method];
      L[method] = function (...args) {
        try { window.__bgtrafficLeaflet.push({ kind: method, data: args[0] }); } catch {}
        return original.apply(this, args);
      };
    }
    for (const method of ['marker', 'circleMarker', 'circle']) {
      if (typeof L[method] !== 'function') continue;
      const original = L[method];
      L[method] = function (...args) {
        const captured = { kind: method, latlng: args[0], options: args[1] || {}, popup: '', tooltip: '' };
        window.__bgtrafficLeaflet.push(captured);
        const layer = original.apply(this, args);
        if (layer && typeof layer.bindPopup === 'function') {
          const bindPopup = layer.bindPopup;
          layer.bindPopup = function (content, ...rest) {
            captured.popup = serializeContent(content);
            return bindPopup.call(this, content, ...rest);
          };
        }
        if (layer && typeof layer.bindTooltip === 'function') {
          const bindTooltip = layer.bindTooltip;
          layer.bindTooltip = function (content, ...rest) {
            captured.tooltip = serializeContent(content);
            return bindTooltip.call(this, content, ...rest);
          };
        }
        return layer;
      };
    }
  };
  install();
  setInterval(install, 50);
});

context.on('response', (response) => {
  const task = inspectResponse(response).finally(() => pendingResponses.delete(task));
  pendingResponses.add(task);
});
context.on('requestfailed', (request) => {
  diagnostics.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText || 'unknown' });
});
context.on('websocket', (socket) => {
  socket.on('framereceived', ({ payload }) => {
    diagnostics.webSocketFrames++;
    if (typeof payload === 'string') parseText(payload, { url: socket.url() });
  });
});

async function acceptCookies(page) {
  for (const label of ['Приемам', 'Съгласен съм', 'Разрешавам всички', 'Accept all']) {
    const button = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
    try { if (await button.isVisible({ timeout: 500 })) await button.click(); } catch {}
  }
}

async function harvestPage(page) {
  const allCaptured = [];
  for (const frame of page.frames()) {
    try {
      const captured = await frame.evaluate(() => ({
        url: location.href,
        leaflet: Array.isArray(window.__bgtrafficLeaflet) ? window.__bgtrafficLeaflet : [],
        scripts: [...document.scripts].map((script) => script.textContent || '').filter((text) => /count15min|count1Hour|count_15m|count_60m/i.test(text)).slice(0, 100),
      }));
      allCaptured.push(captured);
    } catch {}
  }
  for (const captured of allCaptured) {
    diagnostics.leafletObjects += captured.leaflet.length;
    diagnostics.inlineCandidates += captured.scripts.length;
    for (const layer of captured.leaflet) {
      if (layer?.kind === 'geoJSON' || layer?.kind === 'geoJson') {
        walk(layer.data, { url: captured.url || OFFICIAL_PAGE });
        continue;
      }
      const merged = {
        ...(layer?.options && typeof layer.options === 'object' ? layer.options : {}),
        popup: layer?.popup || '',
        tooltip: layer?.tooltip || '',
        latlng: layer?.latlng,
      };
      addRecord(normalizeObject(merged, { latlng: layer?.latlng, popup: layer?.popup, tooltip: layer?.tooltip, url: captured.url || OFFICIAL_PAGE }));
      walk(layer, { url: captured.url || OFFICIAL_PAGE });
    }
    for (const scriptText of captured.scripts) parseText(scriptText, { url: captured.url || OFFICIAL_PAGE });
  }
}

const page = await context.newPage();
let pageError = null;
diagnostics.attempts = [];
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = records.size;
    if (attempt === 1) {
      await page.goto(OFFICIAL_PAGE, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    }
    await page.waitForTimeout(3000);
    await acceptCookies(page);
    await page.waitForTimeout(attempt === 1 ? WAIT_MS : Math.max(15000, Math.round(WAIT_MS / 2)));
    await Promise.allSettled([...pendingResponses]);
    await harvestPage(page);
    await Promise.allSettled([...pendingResponses]);
    diagnostics.attempts.push({ attempt, added: records.size - before, total: records.size, url: page.url() });
    if (records.size >= MIN_RECORDS) break;
  }
  await page.screenshot({ path: path.join(diagnosticsDir, 'bgtoll-traffic.png'), fullPage: true });
} catch (error) {
  pageError = error;
  diagnostics.pageError = String(error?.message || error);
  try { await page.screenshot({ path: path.join(diagnosticsDir, 'bgtoll-traffic-error.png'), fullPage: true }); } catch {}
}

const normalized = [...records.values()]
  .filter((record) => Number.isFinite(record.count_15m) && Number.isFinite(record.count_60m))
  .sort((a, b) => a.external_id.localeCompare(b.external_id, 'bg'));

diagnostics.finishedAt = new Date().toISOString();
diagnostics.recordCount = normalized.length;
diagnostics.matchedResponseCount = diagnostics.matchedResponses.length;
await fs.writeFile(path.join(diagnosticsDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
await fs.writeFile(path.join(diagnosticsDir, 'traffic-records.json'), JSON.stringify(normalized, null, 2));

if (normalized.length < MIN_RECORDS) {
  await browser.close();
  throw new Error(`Официалната карта върна само ${normalized.length} валидни трафик точки. Данните не са изпратени. ${pageError ? `Грешка на страницата: ${pageError.message}` : ''}`);
}

const capturedFrom = diagnostics.matchedResponses[0]?.url || OFFICIAL_PAGE;
const payload = {
  source: 'bgtoll_traffic',
  schema_version: 1,
  collector_version: COLLECTOR_VERSION,
  collected_at: new Date().toISOString(),
  official_page: OFFICIAL_PAGE,
  captured_from: capturedFrom,
  records: normalized,
  diagnostics: {
    response_count: diagnostics.responseCount,
    inspected_responses: diagnostics.inspectedResponses,
    matched_responses: diagnostics.matchedResponses.slice(0, 20),
    leaflet_objects: diagnostics.leafletObjects,
    inline_candidates: diagnostics.inlineCandidates,
    failed_requests: diagnostics.failedRequests.slice(0, 20),
  },
};

await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2));

let delivery = { mode: DELIVERY_MODE, output: OUTPUT_FILE };
if (DELIVERY_MODE === 'http') {
  const response = await fetch(INGEST_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INGEST_TOKEN}`,
      'X-BGTraffic-Token': INGEST_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': `BGTrafficBrowserCollector/${COLLECTOR_VERSION}`,
    },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  let responseBody;
  try { responseBody = JSON.parse(responseText); } catch { responseBody = { raw: responseText }; }
  if (!response.ok || !responseBody.success) {
    await browser.close();
    throw new Error(`BGTraffic.eu отказа payload-а: HTTP ${response.status} · ${responseBody.message || responseText}`);
  }
  delivery = { mode: 'http', ingest: responseBody };
}

console.log(JSON.stringify({
  success: true,
  collected: normalized.length,
  capturedFrom,
  delivery,
}, null, 2));

await browser.close();
