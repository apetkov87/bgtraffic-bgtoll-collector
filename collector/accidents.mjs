import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const DASHBOARD_PAGE = process.env.MVR_ACCIDENTS_PAGE || 'https://www.mvr.bg/map/apps/dashboards/0b7065b1f1d34d7d8ad530c51434a9f0';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_ACCIDENTS_OUTPUT || 'collector-output/accidents.json');
const DIAG = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');
const VERSION = '2.2.0';
const MAX_RECORDS = Math.max(1000, Number(process.env.MVR_MAX_RECORDS || 50000));
const MIN_RECORDS = Math.max(1, Number(process.env.MVR_MIN_RECORDS || 10));

const dashboardUrl = new URL(DASHBOARD_PAGE);
const dashboardItemId = dashboardUrl.pathname.match(/[a-f0-9]{32}/i)?.[0]?.toLowerCase() || '';
const records = new Map();
const itemQueue = [];
const visitedItems = new Set();
const serviceUrls = new Set();
const sharingBases = new Set();
const pendingResponses = new Set();
const directFeatureResponses = [];
const diagnostics = {
  dashboardPage: DASHBOARD_PAGE,
  finalPageUrl: null,
  dashboardItemId,
  pageError: null,
  clickedMapControls: [],
  sharingBases: [],
  itemRequests: [],
  portalSearches: [],
  discoveredItems: [],
  discoveredServices: [],
  directFeatureResponses: [],
  layerCandidates: [],
  layerQueries: [],
  recordCount: 0,
};

const clean = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const numberValue = (value) => {
  if (typeof value === 'string') value = value.trim().replace(',', '.');
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const normalizedKey = (value) => clean(value).toLowerCase().replace(/[^a-zа-я0-9]+/gu, '');
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
    const time = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(fallbackTime) ? fallbackTime : '00:00:00';
    raw = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${time.padEnd(8, ':00')}+03:00`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const time = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(fallbackTime) ? fallbackTime : '00:00:00';
    raw = `${raw}T${time.padEnd(8, ':00')}+03:00`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coordinates(geometry, attributes = {}) {
  if (!geometry || typeof geometry !== 'object') {
    const latitude = numberValue(findField(attributes, ['latitude', 'lat', 'ширина']));
    const longitude = numberValue(findField(attributes, ['longitude', 'lon', 'lng', 'дължина']));
    return [latitude, longitude];
  }
  let longitude = numberValue(geometry.x ?? geometry.longitude ?? geometry.lng);
  let latitude = numberValue(geometry.y ?? geometry.latitude ?? geometry.lat);
  if ((longitude == null || latitude == null) && Array.isArray(geometry.coordinates)) {
    longitude = numberValue(geometry.coordinates[0]);
    latitude = numberValue(geometry.coordinates[1]);
  }
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
  if (/област|община|населено|location|address|геометр|shape/.test(value)) score += 2;
  return score;
}

function normalizeFeature(feature, layerMeta = {}) {
  const attributes = feature?.attributes ?? feature?.properties ?? feature;
  if (!attributes || typeof attributes !== 'object') return null;
  const [latitude, longitude] = coordinates(feature?.geometry ?? attributes.geometry, attributes);
  if (latitude == null || longitude == null || latitude < 40 || latitude > 45 || longitude < 20 || longitude > 30) return null;

  const fieldText = `${layerMeta.name || ''} ${Object.keys(attributes).join(' ')} ${(layerMeta.fields || []).map((field) => `${field.name || ''} ${field.alias || ''}`).join(' ')}`;
  if (accidentSignals(fieldText) < 3) return null;

  const timeRaw = clean(findField(attributes, ['час', 'time', 'hour', 'chas']) ?? '');
  const occurredAt = dateValue(findField(attributes, ['occurred_at', 'datetime', 'date_time', 'datachas', 'data_chas', 'датаичас', 'дата', 'date']), timeRaw) || new Date().toISOString();
  const objectIdField = layerMeta.objectIdField || 'OBJECTID';
  const externalValue = clean(findField(attributes, ['globalid', objectIdField, 'objectid', 'id', 'ptpid', 'номер']) ?? `${occurredAt}|${latitude}|${longitude}`);
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
    external_id: `${layerMeta.id ?? 'layer'}:${externalValue}`,
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
    source_extra: Object.fromEntries(Object.entries(attributes).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 140)),
  };
}

function addFeatureCollection(json, meta = {}) {
  const features = Array.isArray(json?.features) ? json.features : Array.isArray(json?.results) ? json.results : [];
  let added = 0;
  for (const feature of features) {
    const normalized = normalizeFeature(feature, meta);
    if (!normalized) continue;
    const before = records.size;
    records.set(normalized.external_id, normalized);
    if (records.size > before) added++;
  }
  return added;
}

function addItemId(value) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(/\b[a-f0-9]{32}\b/gi)) {
    const id = match[0].toLowerCase();
    if (!visitedItems.has(id) && !itemQueue.includes(id)) itemQueue.push(id);
  }
}

function addSharingBase(value) {
  if (typeof value !== 'string') return;
  const match = value.replace(/\\\//g, '/').match(/^(https?:\/\/[^/]+(?:\/[^/]+)*)\/sharing\/rest/i);
  if (match) sharingBases.add(`${match[1]}/sharing/rest`);
}

function addServiceUrl(value) {
  if (typeof value !== 'string') return;
  const decoded = value.replace(/\\\//g, '/');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+?\/(?:FeatureServer|MapServer)(?:\/\d+)?/gi)) {
    serviceUrls.add(match[0].replace(/[),.;\\]+$/, ''));
  }
}

function discover(value, depth = 0, seen = new WeakSet()) {
  if (depth > 24 || value == null) return;
  if (typeof value === 'string') { addItemId(value); addServiceUrl(value); addSharingBase(value); return; }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) discover(item, depth + 1, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/itemid|webmap|portalitem|mapid|id$/i.test(key) && typeof child === 'string') addItemId(child);
    if (/url|service|portal/i.test(key) && typeof child === 'string') { addServiceUrl(child); addSharingBase(child); }
    discover(child, depth + 1, seen);
  }
}

async function inspectResponse(response) {
  const url = response.url();
  addSharingBase(url);
  addServiceUrl(url);
  addItemId(url);
  const contentType = (await response.headerValue('content-type')) || '';
  if (response.status() < 200 || response.status() >= 400) return;
  if (!/json|text|javascript/i.test(contentType) && !/sharing\/rest|FeatureServer|MapServer|query/i.test(url)) return;
  try {
    const body = await response.body();
    if (!body.length || body.length > 60 * 1024 * 1024) return;
    const text = body.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json) {
      discover(json);
      const added = addFeatureCollection(json, { id: 'network', name: url });
      if (added > 0) directFeatureResponses.push({ url, added });
    } else discover(text);
  } catch {}
}

async function requestJson(request, url, label) {
  const fullUrl = url + (url.includes('?') ? '&' : '?') + 'f=json';
  const info = { label, url: fullUrl, status: null };
  try {
    const response = await request.get(fullUrl, { timeout: 90000, headers: { Referer: DASHBOARD_PAGE, Accept: 'application/json,text/plain,*/*' } });
    info.status = response.status();
    const text = await response.text();
    info.bytes = Buffer.byteLength(text);
    diagnostics.itemRequests.push(info);
    if (!response.ok()) return null;
    const json = JSON.parse(text);
    if (json?.error) { info.apiError = json.error; return null; }
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
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.7', DNT: '1' },
});

const initialPortalPath = dashboardUrl.pathname.split('/').filter(Boolean)[0] || 'map';
sharingBases.add(`${dashboardUrl.origin}/${initialPortalPath}/sharing/rest`);
if (dashboardUrl.hostname.startsWith('www.')) sharingBases.add(`${dashboardUrl.protocol}//${dashboardUrl.hostname.slice(4)}/${initialPortalPath}/sharing/rest`);
else sharingBases.add(`${dashboardUrl.protocol}//www.${dashboardUrl.hostname}/${initialPortalPath}/sharing/rest`);
sharingBases.add('https://www.arcgis.com/sharing/rest');
if (dashboardItemId) itemQueue.push(dashboardItemId);

context.on('response', (response) => {
  const task = inspectResponse(response).finally(() => pendingResponses.delete(task));
  pendingResponses.add(task);
});

const page = await context.newPage();
try {
  await page.goto(DASHBOARD_PAGE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(15000);
  diagnostics.finalPageUrl = page.url();
  const final = new URL(page.url());
  const segment = final.pathname.split('/').filter(Boolean)[0] || 'map';
  sharingBases.add(`${final.origin}/${segment}/sharing/rest`);

  // The map tab is lazy-loaded. Without clicking it, the dashboard does not request the feature layers.
  for (let round = 0; round < 3; round++) {
    for (const frame of page.frames()) {
      const selectors = [
        frame.getByText(/^Карта$/i),
        frame.getByText(/Карта на ПТП|Виж картата/i),
        frame.locator('button,a,[role="button"],[role="tab"]').filter({ hasText: /^\s*Карта\s*$/i }),
      ];
      for (const locator of selectors) {
        const count = Math.min(await locator.count().catch(() => 0), 10);
        for (let index = 0; index < count; index++) {
          const element = locator.nth(index);
          try {
            if (!(await element.isVisible({ timeout: 300 }))) continue;
            diagnostics.clickedMapControls.push(clean(await element.textContent()));
            await element.scrollIntoViewIfNeeded();
            await element.click({ timeout: 5000, force: true });
            await page.waitForTimeout(5000);
          } catch {}
        }
      }
    }
    await page.waitForTimeout(10000);
  }

  // Harvest URLs/IDs from all rendered frames after the map tab has loaded.
  for (const frame of page.frames()) {
    try {
      const snapshot = await frame.evaluate(() => ({
        url: location.href,
        html: document.documentElement.outerHTML.slice(0, 8_000_000),
        resources: performance.getEntriesByType('resource').map((entry) => entry.name).slice(-3000),
      }));
      discover(snapshot.url);
      discover(snapshot.html);
      for (const resource of snapshot.resources) discover(resource);
    } catch {}
  }
  await Promise.allSettled([...pendingResponses]);
  await page.screenshot({ path: path.join(DIAG, 'mvr-dashboard.png'), fullPage: true });
} catch (error) {
  diagnostics.pageError = String(error?.message || error);
}

// Public portal search is a fallback for dashboards whose item data hides data sources.
async function portalSearch(base, query) {
  const url = `${base}/search?f=json&num=100&sortField=modified&sortOrder=desc&q=${encodeURIComponent(query)}`;
  const info = { base, query, status: null, results: 0 };
  try {
    const response = await context.request.get(url, { timeout: 90000, headers: { Referer: DASHBOARD_PAGE, Accept: 'application/json' } });
    info.status = response.status();
    if (!response.ok()) { diagnostics.portalSearches.push(info); return; }
    const json = await response.json();
    const results = Array.isArray(json?.results) ? json.results : [];
    info.results = results.length;
    diagnostics.portalSearches.push(info);
    for (const item of results) {
      diagnostics.discoveredItems.push({ id: item.id || '', title: item.title || '', type: item.type || '', url: item.url || '', via: 'search' });
      discover(item);
      if (item.id) addItemId(item.id);
      if (item.url) addServiceUrl(item.url);
    }
  } catch (error) {
    info.error = String(error?.message || error);
    diagnostics.portalSearches.push(info);
  }
}

for (const base of [...sharingBases]) {
  await portalSearch(base, 'ПТП OR пътнотранспортни OR катастрофи');
  await portalSearch(base, 'type:("Feature Service" OR "Web Map") AND (ПТП OR произшествия)');
}

// Resolve dashboard, web maps, feature-service items and related items using every discovered portal base.
while (itemQueue.length && visitedItems.size < 250) {
  const itemId = itemQueue.shift();
  if (!itemId || visitedItems.has(itemId)) continue;
  visitedItems.add(itemId);
  let resolved = false;
  for (const base of [...sharingBases]) {
    const metadata = await requestJson(context.request, `${base}/content/items/${itemId}`, `item:${itemId}`);
    const data = await requestJson(context.request, `${base}/content/items/${itemId}/data`, `item-data:${itemId}`);
    if (!metadata && !data) continue;
    resolved = true;
    diagnostics.discoveredItems.push({ id: itemId, title: metadata?.title || '', type: metadata?.type || '', url: metadata?.url || '', portal: base });
    if (metadata) discover(metadata);
    if (data) discover(data);
    if (metadata?.url) addServiceUrl(metadata.url);
    break;
  }
  if (!resolved) diagnostics.discoveredItems.push({ id: itemId, unresolved: true });
}

diagnostics.sharingBases = [...sharingBases];
diagnostics.discoveredServices = [...serviceUrls];
diagnostics.directFeatureResponses = directFeatureResponses;

function splitServiceUrl(url) {
  const cleanUrl = url.split('?')[0].replace(/\/$/, '');
  const match = cleanUrl.match(/^(.*\/(?:FeatureServer|MapServer))(?:\/(\d+))?$/i);
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

const sortedLayers = [...layerCandidates.values()].filter((candidate) => candidate.score >= 3).sort((a, b) => b.score - a.score);
for (const layer of sortedLayers) {
  if (records.size >= MAX_RECORDS) break;
  const dateField = (layer.fields || []).find((field) => /date|дата|datetime|data_chas/i.test(`${field.name} ${field.alias || ''}`) && /date/i.test(field.type || ''))?.name
    || (layer.fields || []).find((field) => /date|дата|datetime|data_chas/i.test(`${field.name} ${field.alias || ''}`))?.name;
  const batchSize = Math.min(2000, Math.max(100, layer.maxRecordCount || 2000));
  let offset = 0;
  while (records.size < MAX_RECORDS) {
    const params = new URLSearchParams({
      where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json',
      resultOffset: String(offset), resultRecordCount: String(batchSize),
    });
    if (dateField) params.set('orderByFields', `${dateField} DESC`);
    const queryUrl = `${layer.url}/query?${params.toString()}`;
    const queryInfo = { layer: layer.url, offset, status: null, added: 0 };
    try {
      const response = await context.request.get(queryUrl, { timeout: 120000, headers: { Referer: DASHBOARD_PAGE, Accept: 'application/json' } });
      queryInfo.status = response.status();
      if (!response.ok()) { diagnostics.layerQueries.push(queryInfo); break; }
      const json = await response.json();
      const features = Array.isArray(json?.features) ? json.features : [];
      queryInfo.features = features.length;
      queryInfo.added = addFeatureCollection(json, layer);
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
  throw new Error(`Не са намерени валидни ПТП записи. Натиснати контроли „Карта“: ${diagnostics.clickedMapControls.length}; портали: ${sharingBases.size}; items: ${visitedItems.size}; услуги: ${serviceUrls.size}; слоеве: ${sortedLayers.length}; записи: ${list.length}.`);
}

const successfulLayer = diagnostics.layerQueries.find((query) => query.features > 0)?.layer || directFeatureResponses[0]?.url || DASHBOARD_PAGE;
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
    clicked_map_controls: diagnostics.clickedMapControls,
    resolved_items: diagnostics.discoveredItems.slice(0, 50),
    service_count: serviceUrls.size,
    layers: diagnostics.layerCandidates.filter((layer) => layer.score >= 3).slice(0, 30),
    successful_layer: successfulLayer,
  },
};

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
await browser.close();
console.log(JSON.stringify({ success: true, accidentRecords: list.length, capturedFrom: successfulLayer }, null, 2));
