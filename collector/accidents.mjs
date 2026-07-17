import fs from 'node:fs/promises';
import path from 'node:path';

const LAYER = process.env.MVR_ACCIDENTS_LAYER || 'https://services3.arcgis.com/jzslazl8UKsLRsUc/arcgis/rest/services/PTP_Analysis_WFL1/FeatureServer/3';
const OFFICIAL_PAGE = process.env.MVR_ACCIDENTS_PAGE || 'https://www.mvr.bg/map/apps/dashboards/0b7065b1f1d34d7d8ad530c51434a9f0';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_ACCIDENTS_OUTPUT || 'collector-output/accidents.json');
const DIAG = path.resolve(process.env.BGTRAFFIC_DIAGNOSTICS_DIR || 'collector-diagnostics');
const VERSION = '2.3.0';
const FROM_YEAR = Math.max(2024, Number(process.env.MVR_FROM_YEAR || 2024));
const MAX_RECORDS = Math.max(1000, Number(process.env.MVR_MAX_RECORDS || 50000));
const MIN_RECORDS = Math.max(1, Number(process.env.MVR_MIN_RECORDS || 10));
const diagnostics = { officialPage: OFFICIAL_PAGE, layer: LAYER, fromYear: FROM_YEAR, metadata: null, attempts: [], recordCount: 0 };

const clean = (v) => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => { if (typeof v === 'string') v = v.trim().replace(',', '.'); const n = Number(v); return Number.isFinite(n) ? n : null; };
function toIso(value, time = '') {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    let ts = Number(value); if (ts < 2e10) ts *= 1000;
    const d = new Date(ts); return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let raw = clean(value);
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw)) {
    const [d,m,y] = raw.split('.'); const t = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(time) ? time : '00:00:00';
    raw = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${t.padEnd(8,':00')}+03:00`;
  }
  const date = new Date(raw); return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function normalize(feature) {
  const a = feature?.attributes || {};
  const g = feature?.geometry || {};
  let longitude = num(g.x ?? a.PTP_Layer_x), latitude = num(g.y ?? a.PTP_Layer_y);
  if (longitude == null || latitude == null) return null;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    longitude = longitude / 20037508.34 * 180;
    latitude = latitude / 20037508.34 * 180;
    latitude = 180 / Math.PI * (2 * Math.atan(Math.exp(latitude * Math.PI / 180)) - Math.PI / 2);
  }
  if (latitude < 40 || latitude > 45 || longitude < 20 || longitude > 30) return null;
  const year = Number(a.PTP_Layer_year ?? a.year_txt ?? 0);
  if (Number.isFinite(year) && year > 0 && year < FROM_YEAR) return null;
  const occurredAt = toIso(a.PTP_Layer_datetime_f ?? a.PTP_Layer_date, clean(a.PTP_Layer_time)) || new Date().toISOString();
  const injured = Math.max(0, Math.round(num(a.PTP_Layer_injured) || 0));
  const fatalities = Math.max(0, Math.round(num(a.PTP_Layer_died) || 0));
  const region = clean(a.PTP_Layer_AddSpatialJoin_provincena ?? a.PTP_Layer_AddSpatialJoin_OBL ?? '');
  const type = clean(a.PTP_Layer_type || 'Пътнотранспортно произшествие');
  return {
    external_id: `mvr:${a.OBJECTID ?? `${occurredAt}|${latitude}|${longitude}`}`,
    occurred_at: occurredAt,
    latitude, longitude,
    location: region || 'Неуточнено място', municipality: '', region,
    severity: type || (fatalities ? 'ПТП със загинали' : injured ? 'ПТП с ранени' : 'Пътнотранспортно произшествие'),
    injured, fatalities, road_code: '', description: '',
    source_extra: Object.fromEntries(Object.entries(a).filter(([,v]) => ['string','number','boolean'].includes(typeof v))),
  };
}
async function json(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'BGTraffic.eu/2.3.0' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${url}`);
  const data = JSON.parse(text);
  if (data?.error) throw new Error(`${data.error.code || ''} ${data.error.message || 'ArcGIS error'}`.trim());
  return data;
}

await fs.mkdir(DIAG, { recursive: true });
try { diagnostics.metadata = await json(`${LAYER}?f=json`); } catch (error) { diagnostics.metadataError = String(error?.message || error); }
const batchSize = Math.min(2000, Math.max(100, Number(diagnostics.metadata?.maxRecordCount || 2000)));
const records = new Map();
const whereOptions = [`PTP_Layer_year >= ${FROM_YEAR}`, `year_txt >= '${FROM_YEAR}'`, '1=1'];
for (const where of whereOptions) {
  let offset = 0;
  let accepted = 0;
  while (records.size < MAX_RECORDS) {
    const params = new URLSearchParams({
      where, outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json',
      resultOffset: String(offset), resultRecordCount: String(batchSize), orderByFields: 'PTP_Layer_datetime_f DESC',
    });
    const url = `${LAYER}/query?${params}`;
    const attempt = { where, offset, status: 'ok', features: 0, added: 0 };
    try {
      const data = await json(url);
      const features = Array.isArray(data.features) ? data.features : [];
      attempt.features = features.length;
      for (const feature of features) {
        const row = normalize(feature); if (!row) continue;
        const before = records.size; records.set(row.external_id, row); if (records.size > before) attempt.added++;
      }
      accepted += attempt.added;
      diagnostics.attempts.push(attempt);
      if (!features.length || features.length < batchSize || data.exceededTransferLimit === false) break;
      offset += features.length;
    } catch (error) {
      attempt.status = 'error'; attempt.error = String(error?.message || error); diagnostics.attempts.push(attempt); break;
    }
  }
  if (accepted >= MIN_RECORDS) break;
}
const list = [...records.values()].sort((a,b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, MAX_RECORDS);
diagnostics.recordCount = list.length;
await fs.writeFile(path.join(DIAG, 'mvr-accidents-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
if (list.length < MIN_RECORDS) throw new Error(`Не са намерени валидни ПТП записи от директния ArcGIS слой. Записи: ${list.length}.`);
const payload = {
  source: 'mvr_accidents', schema_version: 1, collector_version: VERSION,
  collected_at: new Date().toISOString(), official_page: OFFICIAL_PAGE, captured_from: LAYER,
  records: list,
  diagnostics: { from_year: FROM_YEAR, layer: LAYER, attempts: diagnostics.attempts.slice(0,20) },
};
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ success: true, accidentRecords: list.length, capturedFrom: LAYER, fromYear: FROM_YEAR }, null, 2));
