import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE = process.env.BGTOLL_WEATHER_PAGE || 'https://bgtoll.bg/mto/';
const OUTPUT = path.resolve(process.env.BGTRAFFIC_WEATHER_OUTPUT || 'collector-output/weather.json');
const DIAG = path.resolve('collector-diagnostics');
const records = new Map();
const responses=[];
const num=v=>{if(typeof v==='string')v=v.trim().replace(',','.');const n=Number(v);return Number.isFinite(n)?n:null};
const pick=(o,keys)=>{if(!o||typeof o!=='object')return null;for(const k of keys){const a=Object.keys(o).find(x=>x.toLowerCase()===k.toLowerCase());if(a&&o[a]!==''&&o[a]!=null)return o[a]}return null};
const clean=v=>String(v??'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
function normalize(o,ctx={}){
 if(!o||typeof o!=='object'||Array.isArray(o))return null;
 let lat=num(pick(o,['lat','latitude','y'])),lng=num(pick(o,['lon','lng','longitude','x']));
 const c=pick(o,['coordinates','latlng','position']); if((lat==null||lng==null)&&Array.isArray(c)&&c.length>1){let a=num(c[0]),b=num(c[1]);if(a>40&&a<45){lat=a;lng=b}else{lng=a;lat=b}}
 if((lat==null||lng==null)&&ctx.latlng){lat=num(ctx.latlng.lat??ctx.latlng[0]);lng=num(ctx.latlng.lng??ctx.latlng.lon??ctx.latlng[1])}
 if(lat==null||lng==null||lat<40||lat>45||lng<20||lng>30)return null;
 const air=num(pick(o,['air','air_temperature','temperature_air','airTemp','temp_air','tair']));
 const surface=num(pick(o,['surface','road_temperature','temperature_road','surface_temperature','roadTemp','tsurface']));
 const humidity=num(pick(o,['humidity','relative_humidity','rh']));
 const pressure=num(pick(o,['pressure','atmospheric_pressure','barometer']));
 if(air==null&&surface==null&&humidity==null&&pressure==null)return null;
 const id=clean(pick(o,['station_id','stationId','external_id','id','code'])??`${lat}|${lng}`);
 const name=clean(pick(o,['name','station_name','stationName','title','location'])??`Пътна станция ${id}`);
 const measured=clean(pick(o,['measured_at','measuredAt','timestamp','time','date','updated_at'])??new Date().toISOString());
 return {external_id:id,name,latitude:lat,longitude:lng,temperature_air:air,temperature_road:surface,humidity,pressure,measured_at:measured};
}
function walk(v,ctx={},depth=0,seen=new WeakSet()){
 if(depth>14||v==null||typeof v!=='object'||seen.has(v))return;seen.add(v);
 if(Array.isArray(v)){for(const x of v)walk(x,ctx,depth+1,seen);return}
 const n=normalize(v,ctx);if(n)records.set(`${n.external_id}|${n.latitude.toFixed(5)}|${n.longitude.toFixed(5)}`,n);
 for(const x of Object.values(v))walk(x,ctx,depth+1,seen);
}
function parse(text,ctx={}){try{walk(JSON.parse(text),ctx)}catch{}}
await fs.mkdir(DIAG,{recursive:true});
const browser=await chromium.launch({headless:true});const context=await browser.newContext({locale:'bg-BG',timezoneId:'Europe/Sofia',viewport:{width:1440,height:1000}});
context.on('response',async r=>{const u=r.url(),ct=(await r.headerValue('content-type'))||'';if(r.status()<200||r.status()>=400)return;if(!/json|text|javascript/i.test(ct)&&!/weather|meteo|mto|station|data|api/i.test(u))return;try{const b=await r.body();if(b.length>20e6)return;const before=records.size;parse(b.toString('utf8'),{url:u});if(records.size>before)responses.push({url:u,added:records.size-before})}catch{}});
await context.addInitScript(()=>{window.__bgWeather=[];const install=()=>{if(!window.L||window.L.__bgw)return;window.L.__bgw=true;for(const m of ['marker','circleMarker']){const old=window.L[m];if(typeof old!=='function')continue;window.L[m]=function(...args){const x={latlng:args[0],options:args[1]||{},popup:''};window.__bgWeather.push(x);const l=old.apply(this,args);if(l?.bindPopup){const b=l.bindPopup;l.bindPopup=function(c,...r){x.popup=typeof c==='string'?c:c?.textContent||'';return b.call(this,c,...r)}}return l}}};install();setInterval(install,50)});
const page=await context.newPage();let error='';try{await page.goto(PAGE,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForTimeout(30000);for(const f of page.frames()){try{const cap=await f.evaluate(()=>({url:location.href,l:window.__bgWeather||[]}));for(const x of cap.l){const merged={...(x.options||{}),popup:x.popup};const n=normalize(merged,{latlng:x.latlng,url:cap.url});if(n)records.set(`${n.external_id}|${n.latitude.toFixed(5)}|${n.longitude.toFixed(5)}`,n);walk(x,{latlng:x.latlng,url:cap.url})}}catch{}}await page.screenshot({path:path.join(DIAG,'bgtoll-weather.png'),fullPage:true})}catch(e){error=String(e?.message||e)}
const list=[...records.values()];if(!list.length){await browser.close();throw new Error('Не са разпознати пътни метеостанции.');}const payload={source:'bgtoll_weather',schema_version:1,collector_version:'2.0.0',collected_at:new Date().toISOString(),official_page:PAGE,captured_from:responses[0]?.url||PAGE,records:list,diagnostics:{matched_responses:responses.slice(0,20),page_error:error}};
await fs.mkdir(path.dirname(OUTPUT),{recursive:true});await fs.writeFile(OUTPUT,JSON.stringify(payload,null,2));await browser.close();console.log(`weather records: ${list.length}`);
