# BGTraffic.eu — браузърен колектор за БГТОЛ

Колекторът отваря официалната карта `https://bgtoll.bg/traffic_passes/` в Chromium, следи реалните XHR/fetch/WebSocket отговори и прихваща Leaflet/GeoJSON обектите. Към BGTraffic.eu се изпращат само записи с валидни координати, `count15min` и `count1Hour`.

## GitHub Actions

1. Качи целия проект в публично GitHub repository.
2. В `Settings → Secrets and variables → Actions` добави:
   - `BGTRAFFIC_INGEST_URL` = `https://bgtraffic.eu/api/ingest/bgtoll/traffic`
   - `BGTRAFFIC_INGEST_TOKEN` = токена, показан в администрацията на BGTraffic.eu.
3. Отвори `Actions → BGTraffic · BGTOLL live traffic → Run workflow`.
4. След успешния тест workflow-ът се изпълнява на 7, 22, 37 и 52 минута на всеки час.

При неуспех workflow-ът качва screenshot, диагностика и извлечените записи като artifact.

## Собствен VPS

```bash
cd collector
npm install
npx playwright install --with-deps chromium
BGTRAFFIC_INGEST_URL="https://bgtraffic.eu/api/ingest/bgtoll/traffic" \
BGTRAFFIC_INGEST_TOKEN="TOKEN_FROM_ADMIN" \
npm run collect
```

> При публично repository стандартните GitHub-hosted runners са безплатни. GitHub може да спре scheduled workflow след 60 дни без repository активност; тогава workflow-ът се активира отново от Actions.
