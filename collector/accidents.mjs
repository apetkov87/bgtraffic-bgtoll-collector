import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const DASHBOARD_PAGE = process.env.MVR_ACCIDENTS_PAGE || 'https://www.mvr.bg/map/apps/dashboards/0b7065b1f1d34d7d8ad530c51434a9f0';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_ACCIDENTS_OUTPUT || 'collector-output/accidents.json');
const DIAG = path.resolve('collector-diagnostics');
const VERSION = '2.1.0';
const MAX_RECORDS = Math.max(1000, Number(process.env.MVR_MAX_RECORDS || 50000));
const MIN_RECORDS = Math.max(1, Number(process.env.MVR_MIN_RECORDS || 10));

const dashboardUrl = new URL(DASHBOARD_PAGE);
const dashboardItemId = dashboardUrl.pathname.match(/[a-f0-9]{32}/i)?.[0] || '';
const portalSegment = dashboardUrl.pathname.split('/').filter(Boolean)[0] || 'map';
const portalBase = `${dashboardUrl.origin}/${portalSegment}`;
const sharingBase = `${portalBase}/sharing/rest`;

const diagnostics = {
  dashboardPage: DASHBOARD_PAGE,
  portalBase,
  dashboardItemId,
  pageError: null,
  itemRequests: [],
  discoveredItems: [],
  discoveredServices: [],
  layerCandidates: [],
  layerQueries: [],
  recordCount: 0,
};
const records = new Map();
const itemQueue = [];
const visitedItems = new Set();
const serviceUrls = new Set();

const clean = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const numberValue = (value) => {
  if (typeof value === 'string') value = value.trim().replace(',', '.');
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const normalizedKey = (value) => String(value).toLowerCase().replace(/[^a-zа-я0-9]+/g, '');
const findField = (attributes, patterns) => {
  if (!attributes || typeof attributes !== 'object') return null;
  const keys = Object.keys(attributes);
  for (const pattern of patterns) {
    const exact = keys.find((key) => normalizedKey(key) === normalizedKey(pattern));
    if (exact && attributes[exact] !== '' && attributes[exact] != null) return attributes[exact];
  }
  for (const pattern of patterns) {
    const partial = keys.find((key) => normalizedKey(key).includes(normalizedKey(pattern)));
    if (partial && attributes[partial] !== '' && attributes[partial] != null) return attributes[partial];
  }
  return null;
};

function dateValue(value, fallbackTime = '') {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    let timestamp = Number(value);
    if (timestamp < 2e10) timestamp *= 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  let raw = clean(value);
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split('.');
    raw = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${fallbackTime ? `T${fallbackTime}` : 'T00:00:00'}+03:00`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && fallbackTime) {
    raw = `${raw}T${fallbackTime}+03:00`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coordinates(geometry) {
  if (!geometry || typeof geometry !== 'object') return [null, null];
  let longitude = numberValue(geometry.x ?? geometry.longitude ?? geometry.lng);
  let latitude = numberValue(geometry.y ?? geometry.latitude ?? geometry.lat);
  if (longitude == null || latitude == null) return [null, null];
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    longitude = longitude / 20037508.34 * 180;
    latitude = latitude / 20037508.34 * 180;
    latitude = 180 / Math.PI * (2 * Math.atan(Math.exp(latitude * Math.PI / 180)) - Math.PI / 2);
  }
  return [latitude, longitude];
}

function accidentSignals(text) {
  const value = String(text || '').toLowerCase();
  let score = 0;
  if (/птп|пътнотранспорт|произшеств|катастроф|accident|crash/.test(value)) score += 12;
  if (/ранен|пострадал|injur/.test(value)) score += 5;
  if (/загин|убит|fatal|killed/.test(value)) score += 5;
  if (/дата|date|час|time/.test(value)) score += 2;
  if (/област|община|населено|location|address/.test(value)) score += 2;
  return score;
}

function normalizeFeature(feature, layerMeta = {}) {
  const attributes = feature?.attributes ?? feature?.properties ?? feature;
  if (!attributes || typeof attributes !== 'object') return null;
  const [latitude, longitude] = coordinates(feature?.geometry ?? attributes.geometry);
  if (latitude == null || longitude == null || latitude < 40 || latitude > 45 || longitude < 20 || longitude > 30) return null;

  const fieldText = `${layerMeta.name || ''} ${Object.keys(attributes).join(' ')} ${(layerMeta.fields || []).map((field) => `${field.name || ''} ${field.alias || ''}`).join(' ')}`;
  const signalScore = accidentSignals(fieldText);
  if (signalScore < 4) return null;

  const timeRaw = clean(findField(attributes, ['час', 'time', 'hour', 'chas']) ?? '');
  const occurredAt = dateValue(findField(attributes, ['occurred_at', 'datetime', 'date_time', 'datachas', 'data_chas', 'датаичас', 'дата', 'date']), timeRaw) || new Date().toISOString();
  const objectIdField = layerMeta.objectIdField || 'OBJECTID';
  const externalId = clean(findField(attributes, ['globalid', objectIdField, 'objectid', 'id', 'ptpid', 'номер']) ?? `${occurredAt}|${latitude}|${longitude}`);
  const injured = Math.max(0, Math.round(numberValue(findField(attributes, ['бройранени', 'ранени', 'пострадали', 'injured', 'raneni'])) || 0));
  const fatalities = Math.max(0, Math.round(numberValue(findField(attributes, ['бройзагинали', 'загинали', 'убити', 'fatalities', 'killed', 'zaginali'])) || 0));
  const region = clean(findField(attributes, ['област', 'region', 'oblast']) ?? '');
  const municipality = clean(findField(attributes, ['община', 'municipality', 'obshtina']) ?? '');
  const settlement = clean(findField(attributes, ['населеномясто', 'населено', 'град', 'село', 'settlement', 'town']) ?? '');
  const address = clean(findField(attributes, ['адрес', 'място', 'местоположение', 'location', 'address']) ?? '');
  const location = [settlement, municipality, region].filter(Boolean).join(', ') || address || 'Неуточнено място';
  const severity = clean(findField(attributes, ['видптп', 'виднаптп', 'тежест', 'severity', 'тип', 'type']) ?? (fatalities > 0 ? 'ПТП със загинали' : injured > 0 ? 'ПТП с ранени' : 'Пътнотранспортно произшествие'));
  const roadCode = clean(findField(attributes, ['номернапътя', 'път', 'road', 'pat']) ?? '');
  const description = clean(findField(attributes, ['описание', 'обстоятелства', 'характерномясто', 'description']) ?? '');

  return {
    external_id: `${layerMeta.id ?? 'layer'}:${externalId}`,
    occurred_at: occurredAt,
    latitude,
    longitude,
    location,
    municipality,
    region,
    severity,
    injured,
    fatalities,
    road_code: roadCode,
    description,
    source_extra: Object.fromEntries(Object.entries(attributes).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 120)),
  };
}

function addItemId(value) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(/\b[a-f0-9]{32}\b/gi)) {
    const id = match[0].toLowerCase();
    if (!visitedItems.has(id) && !itemQueue.includes(id)) itemQueue.push(id);
  }
}

function addServiceUrl(value) {
  if (typeof value !== 'string') return;
  const decoded = value.replace(/\\\//g, '/');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+?\/(?:FeatureServer|MapServer)(?:\/\d+)?/gi)) {
    serviceUrls.add(match[0].replace(/[),.;]+$/, ''));
  }
}

function discover(value, depth = 0, seen = new WeakSet()) {
  if (depth > 20 || value == null) return;
  if (typeof value === 'string') { addItemId(value); addServiceUrl(value); return; }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) discover(item, depth + 1, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/itemid|webmap|portalitem|mapid|id$/i.test(key) && typeof child === 'string') addItemId(child);
    if (/url|service/i.test(key) && typeof child === 'string') addServiceUrl(child);
    discover(child, depth + 1, seen);
  }
}

async function requestJson(request, url, label) {
  const fullUrl = url + (url.includes('?') ? '&' : '?') + 'f=pjson';
  const info = { label, url: fullUrl, status: null };
  try {
    const response = await request.get(fullUrl, { timeout: 90000, headers: { Referer: DASHBOARD_PAGE, Accept: 'application/json,text/plain,*/*' } });
    info.status = response.status();
    const text = await response.text();
    info.bytes = Buffer.byteLength(text);
    diagnostics.itemRequests.push(info);
    if (!response.ok()) return null;
    const json = JSON.parse(text);
    if (json?.error) return null;
    return json;
  } catch (error) {
    info.error = String(error?.message || error);
    diagnostics.itemRequests.push(info);
    return null;
  }
}

await fs.mkdir(DIAG, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'bg-BG',
  timezoneId: 'Europe/Sofia',
  viewport: { width: 1440, height: 1000 },
  extraHTTPHeaders: { 'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.7' },
});

if (dashboardItemId) itemQueue.push(dashboardItemId.toLowerCase());

// Browser capture is a fallback and also reveals service URLs hidden by the app configuration.
context.on('response', async (response) => {
  const url = response.url();
  addServiceUrl(url);
  addItemId(url);
  if (!/json|text/i.test((await response.headerValue('content-type')) || '') && !/sharing\/rest|FeatureServer|MapServer/i.test(url)) return;
  try {
    const body = await response.body();
    if (body.length > 40 * 1024 * 1024) return;
    const text = body.toString('utf8');
    try { discover(JSON.parse(text)); } catch { discover(text); }
  } catch {}
});

const page = await context.newPage();
try {
  await page.goto(DASHBOARD_PAGE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(12000);
  await page.screenshot({ path: path.join(DIAG, 'mvr-dashboard.png'), fullPage: true });
} catch (error) {
  diagnostics.pageError = String(error?.message || error);
}

// Resolve the dashboard item, web maps and hosted layers directly through the ArcGIS REST API.
while (itemQueue.length && visitedItems.size < 100) {
  const itemId = itemQueue.shift();
  if (!itemId || visitedItems.has(itemId)) continue;
  visitedItems.add(itemId);
  const metadata = await requestJson(context.request, `${sharingBase}/content/items/${itemId}`, `item:${itemId}`);
  const data = await requestJson(context.request, `${sharingBase}/content/items/${itemId}/data`, `item-data:${itemId}`);
  diagnostics.discoveredItems.push({ id: itemId, title: metadata?.title || '', type: metadata?.type || '', url: metadata?.url || '' });
  if (metadata) discover(metadata);
  if (data) discover(data);
}

diagnostics.discoveredServices = [...serviceUrls];

function splitServiceUrl(url) {
  const match = url.match(/^(.*\/(?:FeatureServer|MapServer))(?:\/(\d+))?$/i);
  return match ? { root: match[1], layerId: match[2] != null ? Number(match[2]) : null } : null;
}

const layerCandidates = new Map();
for (const serviceUrl of serviceUrls) {
  const parsed = splitServiceUrl(serviceUrl);
  if (!parsed) continue;
  if (parsed.layerId != null) {
    layerCandidates.set(`${parsed.root}/${parsed.layerId}`, { url: `${parsed.root}/${parsed.layerId}`, root: parsed.root, id: parsed.layerId });
    continue;
  }
  const serviceMeta = await requestJson(context.request, parsed.root, `service:${parsed.root}`);
  for (const layer of [...(serviceMeta?.layers || []), ...(serviceMeta?.tables || [])]) {
    if (layer?.id == null) continue;
    layerCandidates.set(`${parsed.root}/${layer.id}`, { url: `${parsed.root}/${layer.id}`, root: parsed.root, id: Number(layer.id), name: layer.name || '' });
  }
}

for (const candidate of layerCandidates.values()) {
  const meta = await requestJson(context.request, candidate.url, `layer:${candidate.url}`);
  if (!meta) continue;
  candidate.name = meta.name || candidate.name || '';
  candidate.fields = meta.fields || [];
  candidate.objectIdField = meta.objectIdField || meta.objectIdFieldName || 'OBJECTID';
  candidate.maxRecordCount = Number(meta.maxRecordCount || 2000);
  candidate.score = accidentSignals(`${candidate.name} ${(candidate.fields || []).map((field) => `${field.name || ''} ${field.alias || ''}`).join(' ')}`);
  diagnostics.layerCandidates.push({ url: candidate.url, name: candidate.name, score: candidate.score, fields: candidate.fields.map((field) => field.name) });
}

const sortedLayers = [...layerCandidates.values()].filter((candidate) => candidate.score >= 4).sort((a, b) => b.score - a.score);
for (const layer of sortedLayers) {
  if (records.size >= MAX_RECORDS) break;
  const dateField = (layer.fields || []).find((field) => /date|дата|datetime|data_chas/i.test(`${field.name} ${field.alias || ''}`) && /date/i.test(field.type || ''))?.name
    || (layer.fields || []).find((field) => /date|дата|datetime|data_chas/i.test(`${field.name} ${field.alias || ''}`))?.name;
  const batchSize = Math.min(2000, Math.max(100, layer.maxRecordCount || 2000));
  let offset = 0;
  while (records.size < MAX_RECORDS) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(batchSize),
    });
    if (dateField) params.set('orderByFields', `${dateField} DESC`);
    const queryUrl = `${layer.url}/query?${params.toString()}`;
    const beforeRecords = records.size;
    const queryInfo = { layer: layer.url, offset, status: null, added: 0 };
    try {
      const response = await context.request.get(queryUrl, { timeout: 120000, headers: { Referer: DASHBOARD_PAGE, Accept: 'application/json' } });
      queryInfo.status = response.status();
      if (!response.ok()) { diagnostics.layerQueries.push(queryInfo); break; }
      const json = await response.json();
      const features = Array.isArray(json?.features) ? json.features : [];
      for (const feature of features) {
        const normalized = normalizeFeature(feature, layer);
        if (normalized) records.set(normalized.external_id, normalized);
      }
      queryInfo.features = features.length;
      queryInfo.added = records.size - beforeRecords;
      diagnostics.layerQueries.push(queryInfo);
      if (!features.length || features.length < batchSize || json.exceededTransferLimit === false) break;
      offset += features.length;
    } catch (error) {
      queryInfo.error = String(error?.message || error);
      diagnostics.layerQueries.push(queryInfo);
      break;
    }
  }
}

const list = [...records.values()].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, MAX_RECORDS);
diagnostics.recordCount = list.length;
await fs.writeFile(path.join(DIAG, 'mvr-accidents-diagnostics.json'), JSON.stringify(diagnostics, null, 2));

if (list.length < MIN_RECORDS) {
  await browser.close();
  throw new Error(`Не бяха намерени валидни ПТП записи през ArcGIS REST. Items: ${visitedItems.size}; услуги: ${serviceUrls.size}; слоеве: ${sortedLayers.length}; записи: ${list.length}.`);
}

const successfulLayer = diagnostics.layerQueries.find((query) => query.features > 0)?.layer || DASHBOARD_PAGE;
const payload = {
  source: 'mvr_accidents',
  schema_version: 1,
  collector_version: VERSION,
  collected_at: new Date().toISOString(),
  official_page: DASHBOARD_PAGE,
  captured_from: successfulLayer,
  records: list,
  diagnostics: {
    dashboard_item: dashboardItemId,
    resolved_items: diagnostics.discoveredItems.slice(0, 30),
    service_count: serviceUrls.size,
    layers: diagnostics.layerCandidates.filter((layer) => layer.score >= 4).slice(0, 20),
    successful_layer: successfulLayer,
  },
};

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
await browser.close();
console.log(JSON.stringify({ success: true, accidentRecords: list.length, capturedFrom: successfulLayer }, null, 2));
