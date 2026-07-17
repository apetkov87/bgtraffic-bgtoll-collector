import fs from 'node:fs/promises';
import path from 'node:path';

const DASHBOARD_ID = process.env.MVR_DASHBOARD_ID || '0b7065b1f1d34d7d8ad530c51434a9f0';
const OFFICIAL_PAGE = process.env.MVR_ACCIDENTS_PAGE || `https://www.mvr.bg/map/apps/dashboards/${DASHBOARD_ID}`;
const PORTAL_ROOTS = [
  process.env.MVR_PORTAL_REST || 'https://www.mvr.bg/map/sharing/rest',
  'https://www.arcgis.com/sharing/rest',
];
const OUTPUT = path.resolve(process.env.BGTRAFFIC_ACCIDENTS_OUTPUT || 'collector-output/accidents.json');
const DIAG = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');
const VERSION = '2.4.0';
const FROM_YEAR = Math.max(2024, Number(process.env.MVR_FROM_YEAR || 2024));
const MAX_RECORDS = Math.max(1000, Number(process.env.MVR_MAX_RECORDS || 50000));
const MIN_RECORDS = Math.max(1, Number(process.env.MVR_MIN_RECORDS || 10));
const MAX_ITEMS = Math.max(10, Number(process.env.MVR_MAX_DISCOVERY_ITEMS || 80));
const diagnostics = {
  officialPage: OFFICIAL_PAGE,
  dashboardId: DASHBOARD_ID,
  portalRoots: PORTAL_ROOTS,
  fromYear: FROM_YEAR,
  items: [],
  services: [],
  candidates: [],
  selected: null,
  attempts: [],
  recordCount: 0,
};

const clean = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const canonical = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-zа-я0-9]+/gu, '');
const num = (value) => {
  if (typeof value === 'string') value = value.trim().replace(/\s+/g, '').replace(',', '.');
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 (compatible; BGTraffic.eu/2.4.0; +https://bgtraffic.eu)',
      'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.6',
    },
    redirect: 'follow',
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${url}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Невалиден JSON · ${url}`); }
  if (data?.error) throw new Error(`${data.error.code || ''} ${data.error.message || 'ArcGIS error'} · ${url}`.trim());
  return data;
}

function normalizeServiceUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let value = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
  if (value.startsWith('/')) value = new URL(value, 'https://www.mvr.bg').href;
  const match = value.match(/https?:\/\/[^\s"'<>]+?\/(?:FeatureServer|MapServer)(?:\/\d+)?/i);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/, '').replace(/\/$/, '');
}

function collectReferences(value, refs, keyName = '', depth = 0, seen = new WeakSet()) {
  if (depth > 20 || value == null) return;
  if (typeof value === 'string') {
    const service = normalizeServiceUrl(value);
    if (service) refs.services.add(service);
    const keySuggestsItem = /item|webmap|mapid|portal|datasource|dashboard/i.test(keyName);
    if (keySuggestsItem || /(?:id=|items\/)[a-f0-9]{32}/i.test(value)) {
      for (const match of value.matchAll(/[a-f0-9]{32}/ig)) refs.items.add(match[0].toLowerCase());
    }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectReferences(child, refs, keyName, depth + 1, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /^[a-f0-9]{32}$/i.test(child) && /item|webmap|mapid|portal|datasource|dashboard|map/i.test(key)) {
      refs.items.add(child.toLowerCase());
    }
    collectReferences(child, refs, key, depth + 1, seen);
  }
}

async function fetchPortalItem(id) {
  const errors = [];
  for (const root of PORTAL_ROOTS) {
    try {
      const metadata = await getJson(`${root}/content/items/${id}?f=json`);
      if (!metadata || metadata.error || !metadata.id) throw new Error('Item not found');
      let data = {};
      try { data = await getJson(`${root}/content/items/${id}/data?f=json`); } catch (error) { errors.push(String(error?.message || error)); }
      return { root, metadata, data };
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  throw new Error(errors.join(' | '));
}

async function discoverSources() {
  const itemQueue = [DASHBOARD_ID.toLowerCase()];
  const queued = new Set(itemQueue);
  const visited = new Set();
  const serviceUrls = new Set();

  while (itemQueue.length && visited.size < MAX_ITEMS) {
    const id = itemQueue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    try {
      const item = await fetchPortalItem(id);
      const summary = {
        id,
        portal: item.root,
        title: clean(item.metadata.title),
        type: clean(item.metadata.type),
        url: clean(item.metadata.url),
      };
      diagnostics.items.push(summary);
      const directService = normalizeServiceUrl(item.metadata.url);
      if (directService) serviceUrls.add(directService);
      const refs = { items: new Set(), services: new Set() };
      collectReferences(item.metadata, refs);
      collectReferences(item.data, refs);
      for (const service of refs.services) serviceUrls.add(service);
      for (const childId of refs.items) {
        if (!queued.has(childId) && !visited.has(childId)) {
          queued.add(childId);
          itemQueue.push(childId);
        }
      }
    } catch (error) {
      diagnostics.items.push({ id, error: String(error?.message || error) });
    }
  }

  return serviceUrls;
}

function fieldText(metadata) {
  return (metadata?.fields || []).map((field) => `${field.name || ''} ${field.alias || ''}`).join(' ').toLowerCase();
}

function layerScore(url, metadata) {
  const text = `${url} ${metadata?.name || ''} ${fieldText(metadata)}`.toLowerCase();
  let score = 0;
  if (/\bptp\b|птп/.test(text)) score += 20;
  if (/accident|crash|произшеств|катастроф/.test(text)) score += 16;
  if (/injured|ранен|пострадал/.test(text)) score += 7;
  if (/died|dead|fatal|загинал/.test(text)) score += 7;
  if (/date|datetime|дата|year|година/.test(text)) score += 5;
  if (metadata?.geometryType === 'esriGeometryPoint') score += 5;
  return score;
}

async function expandServices(serviceUrls) {
  const layerUrls = new Set();
  for (const raw of serviceUrls) {
    const url = normalizeServiceUrl(raw);
    if (!url) continue;
    const layerMatch = url.match(/\/(FeatureServer|MapServer)\/(\d+)$/i);
    if (layerMatch) {
      layerUrls.add(url);
      continue;
    }
    try {
      const metadata = await getJson(`${url}?f=json`);
      const children = [...(metadata.layers || []), ...(metadata.tables || [])];
      if (!children.length && metadata.id != null) layerUrls.add(url);
      for (const child of children) {
        if (child?.id != null) layerUrls.add(`${url}/${child.id}`);
      }
    } catch (error) {
      diagnostics.services.push({ url, error: String(error?.message || error) });
    }
  }
  return layerUrls;
}

function fields(metadata) {
  return Array.isArray(metadata?.fields) ? metadata.fields : [];
}
function fieldCandidates(metadata, patterns, types = null) {
  return fields(metadata).filter((field) => {
    if (types && !types.includes(field.type)) return false;
    const text = canonical(`${field.name || ''} ${field.alias || ''}`);
    return patterns.some((pattern) => text.includes(canonical(pattern)));
  });
}
function firstField(metadata, patterns, types = null) {
  return fieldCandidates(metadata, patterns, types)[0]?.name || null;
}
function attrValue(attributes, metadata, patterns) {
  const candidates = fieldCandidates(metadata, patterns);
  for (const field of candidates) {
    const value = attributes?.[field.name];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function webMercatorToLonLat(x, y) {
  const longitude = x / 20037508.34 * 180;
  let latitude = y / 20037508.34 * 180;
  latitude = 180 / Math.PI * (2 * Math.atan(Math.exp(latitude * Math.PI / 180)) - Math.PI / 2);
  return [longitude, latitude];
}
function validBulgarian(longitude, latitude) {
  return Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= 20 && longitude <= 30 && latitude >= 40 && latitude <= 45;
}
function coordinatePair(xValue, yValue) {
  const x = num(xValue), y = num(yValue);
  if (x == null || y == null) return null;
  const direct = [[x, y], [y, x]];
  for (const [longitude, latitude] of direct) if (validBulgarian(longitude, latitude)) return [longitude, latitude];
  for (const [mx, my] of direct) {
    const [longitude, latitude] = webMercatorToLonLat(mx, my);
    if (validBulgarian(longitude, latitude)) return [longitude, latitude];
  }
  return null;
}
function coordinates(feature, metadata) {
  const attributes = feature?.attributes || {};
  const geometry = feature?.geometry || {};
  const pairs = [
    [geometry.x, geometry.y],
    [attrValue(attributes, metadata, ['longitude','lon','дължина','ptplayerx','xc']), attrValue(attributes, metadata, ['latitude','lat','ширина','ptplayery','yc'])],
    [attributes.PTP_Layer_x, attributes.PTP_Layer_y],
    [attributes.PTP_Layer_AddSpatialJoin_xc, attributes.PTP_Layer_AddSpatialJoin_yc],
  ];
  for (const pair of pairs) {
    const result = coordinatePair(pair[0], pair[1]);
    if (result) return result;
  }
  return null;
}

function parseDate(value, timeValue = '') {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(clean(value))) {
    let timestamp = Number(value);
    if (timestamp < 2e10) timestamp *= 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  let raw = clean(value);
  const time = clean(timeValue);
  if (/^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split(/[.\/-]/);
    raw = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time) ? time.padEnd(8, ':00') : '00:00:00'}+03:00`;
  } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw) && time) {
    raw = `${raw}T${time.padEnd(8, ':00')}+03:00`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeFeature(feature, metadata) {
  const attributes = feature?.attributes || {};
  const point = coordinates(feature, metadata);
  if (!point) return { row: null, reason: 'coordinates' };
  const [longitude, latitude] = point;
  const dateValue = attrValue(attributes, metadata, ['datetime','dateandtime','датаичас','date','дата','timestamp']);
  const timeValue = attrValue(attributes, metadata, ['time','час','hour']);
  let occurred = parseDate(dateValue, timeValue);
  let year = num(attrValue(attributes, metadata, ['year','година','yeartxt']));
  if (!occurred && year && year >= 1900 && year <= 2200) occurred = new Date(Date.UTC(year, 0, 1));
  if (!occurred) return { row: null, reason: 'date' };
  if (!year) year = occurred.getUTCFullYear();
  if (year < FROM_YEAR || occurred.getUTCFullYear() < FROM_YEAR) return { row: null, reason: 'old' };

  const injured = Math.max(0, Math.round(num(attrValue(attributes, metadata, ['injured','ранени','пострадали','hasinjure'])) || 0));
  const fatalities = Math.max(0, Math.round(num(attrValue(attributes, metadata, ['died','dead','fatalities','загинали','hasdied'])) || 0));
  const region = clean(attrValue(attributes, metadata, ['provincename','province','region','oblast','област']) || '');
  const municipality = clean(attrValue(attributes, metadata, ['municipality','obshtina','община']) || '');
  const settlement = clean(attrValue(attributes, metadata, ['settlement','location','place','address','ekatte','населеномясто','местоположение']) || '');
  const road = clean(attrValue(attributes, metadata, ['road','roadcode','път','route']) || '');
  const accidentType = clean(attrValue(attributes, metadata, ['type','видптп','accidenttype','category','категория']) || 'Пътнотранспортно произшествие');
  const objectIdField = metadata?.objectIdField || firstField(metadata, ['objectid'], ['esriFieldTypeOID']) || 'OBJECTID';
  const objectId = attributes[objectIdField] ?? attributes.OBJECTID ?? `${occurred.toISOString()}|${latitude}|${longitude}`;
  const locationParts = [settlement, municipality, region].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);

  return {
    row: {
      external_id: `mvr:${metadata?.serviceItemId || canonical(metadata?.name || 'layer')}:${objectId}`,
      occurred_at: occurred.toISOString(),
      latitude,
      longitude,
      location: locationParts.join(', ') || 'Неуточнено място',
      municipality,
      region,
      severity: accidentType || (fatalities ? 'ПТП със загинали' : injured ? 'ПТП с ранени' : 'Пътнотранспортно произшествие'),
      injured,
      fatalities,
      road_code: road,
      description: '',
      source_extra: Object.fromEntries(Object.entries(attributes).filter(([, value]) => ['string','number','boolean'].includes(typeof value)).slice(0, 150)),
    },
    reason: null,
  };
}

function whereOptions(metadata) {
  const result = [];
  const yearFields = fieldCandidates(metadata, ['year','година','yeartxt']);
  for (const field of yearFields) {
    if (field.type === 'esriFieldTypeString') result.push(`${field.name} >= '${FROM_YEAR}'`);
    else result.push(`${field.name} >= ${FROM_YEAR}`);
  }
  const dateFields = fieldCandidates(metadata, ['datetime','dateandtime','датаичас','date','дата','timestamp'], ['esriFieldTypeDate']);
  for (const field of dateFields) {
    result.push(`${field.name} >= DATE '${FROM_YEAR}-01-01'`);
    result.push(`${field.name} >= TIMESTAMP '${FROM_YEAR}-01-01 00:00:00'`);
  }
  result.push('1=1');
  return [...new Set(result)];
}

async function queryFeatures(layerUrl, metadata, where, limit = 200, offset = 0) {
  const dateField = firstField(metadata, ['datetime','dateandtime','датаичас','date','дата','timestamp'], ['esriFieldTypeDate']);
  const orderBy = dateField ? `${dateField} DESC` : (metadata?.objectIdField ? `${metadata.objectIdField} DESC` : '');
  const params = new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    resultOffset: String(offset),
    resultRecordCount: String(limit),
  });
  if (orderBy) params.set('orderByFields', orderBy);
  return getJson(`${layerUrl}/query?${params}`);
}

async function evaluateLayer(url) {
  let metadata;
  try { metadata = await getJson(`${url}?f=json`); } catch (error) {
    diagnostics.candidates.push({ url, error: String(error?.message || error) });
    return null;
  }
  const score = layerScore(url, metadata);
  if (score < 12 || !/Feature Layer|Table/i.test(metadata?.type || 'Feature Layer')) {
    diagnostics.candidates.push({ url, name: metadata?.name || '', score, skipped: 'low-score' });
    return null;
  }
  const rejectionCounts = { coordinates: 0, date: 0, old: 0 };
  let best = null;
  for (const where of whereOptions(metadata)) {
    try {
      const data = await queryFeatures(url, metadata, where, 250, 0);
      const features = Array.isArray(data.features) ? data.features : [];
      const rows = [];
      for (const feature of features) {
        const normalized = normalizeFeature(feature, metadata);
        if (normalized.row) rows.push(normalized.row);
        else if (normalized.reason) rejectionCounts[normalized.reason] = (rejectionCounts[normalized.reason] || 0) + 1;
      }
      if (!best || rows.length > best.rows.length) best = { where, rows, featureCount: features.length };
      if (rows.length >= MIN_RECORDS) break;
    } catch (error) {
      diagnostics.attempts.push({ layer: url, where, error: String(error?.message || error) });
    }
  }
  const summary = {
    url,
    name: metadata?.name || '',
    score,
    fields: fields(metadata).map((field) => ({ name: field.name, alias: field.alias, type: field.type })).slice(0, 80),
    sampleFeatures: best?.featureCount || 0,
    recentRows: best?.rows.length || 0,
    where: best?.where || null,
    rejections: rejectionCounts,
  };
  diagnostics.candidates.push(summary);
  if (!best || best.rows.length === 0) return null;
  return { url, metadata, score, where: best.where, sampleRows: best.rows };
}

async function collectAll(selected) {
  const records = new Map();
  const metadata = selected.metadata;
  const batchSize = Math.min(2000, Math.max(100, Number(metadata?.maxRecordCount || 2000)));
  let offset = 0;
  while (records.size < MAX_RECORDS) {
    const data = await queryFeatures(selected.url, metadata, selected.where, batchSize, offset);
    const features = Array.isArray(data.features) ? data.features : [];
    let added = 0;
    for (const feature of features) {
      const normalized = normalizeFeature(feature, metadata);
      if (!normalized.row) continue;
      const before = records.size;
      records.set(normalized.row.external_id, normalized.row);
      if (records.size > before) added++;
    }
    diagnostics.attempts.push({ layer: selected.url, where: selected.where, offset, features: features.length, added });
    if (!features.length || features.length < batchSize || data.exceededTransferLimit === false) break;
    offset += features.length;
  }
  return [...records.values()].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, MAX_RECORDS);
}

await fs.mkdir(DIAG, { recursive: true });
try {
  const services = await discoverSources();
  diagnostics.services = [...services];
  const layerUrls = await expandServices(services);
  const evaluated = [];
  for (const url of layerUrls) {
    const candidate = await evaluateLayer(url);
    if (candidate) evaluated.push(candidate);
  }
  evaluated.sort((a, b) => (b.sampleRows.length - a.sampleRows.length) || (b.score - a.score));
  const selected = evaluated[0];
  if (!selected) throw new Error(`Не е намерен актуален ArcGIS слой с ПТП от ${FROM_YEAR} г. насам. Проверени слоеве: ${layerUrls.size}.`);
  diagnostics.selected = { url: selected.url, name: selected.metadata?.name || '', where: selected.where, sampleRows: selected.sampleRows.length };
  const list = await collectAll(selected);
  diagnostics.recordCount = list.length;
  await fs.writeFile(path.join(DIAG, 'mvr-accidents-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  if (list.length < MIN_RECORDS) throw new Error(`Актуалният ArcGIS слой върна само ${list.length} валидни ПТП записа.`);

  const payload = {
    source: 'mvr_accidents',
    schema_version: 1,
    collector_version: VERSION,
    collected_at: new Date().toISOString(),
    official_page: OFFICIAL_PAGE,
    captured_from: selected.url,
    records: list,
    diagnostics: {
      portal: diagnostics.items.find((item) => item.id === DASHBOARD_ID.toLowerCase())?.portal || PORTAL_ROOTS[0],
      selected_layer: diagnostics.selected,
      discovered_items: diagnostics.items.length,
      discovered_services: diagnostics.services.length,
      candidate_layers: diagnostics.candidates.length,
    },
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ success: true, accidentRecords: list.length, capturedFrom: selected.url, fromYear: FROM_YEAR }, null, 2));
} catch (error) {
  diagnostics.error = String(error?.message || error);
  await fs.writeFile(path.join(DIAG, 'mvr-accidents-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  throw error;
}
