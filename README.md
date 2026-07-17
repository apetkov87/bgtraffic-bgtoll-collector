# BGTraffic Data Collector v2.3.0

Автоматичен колектор за BGTraffic.eu.

## Потокове

- Трафик на живо от официалната карта на БГТОЛ.
- Пътна метеорология директно от `https://bgtoll.bg/mto/`, включително прихващане на реалния XHR/fetch и same-origin fallback към `/index.php/mto/data`.
- ПТП директно от установения ArcGIS слой на МВР, филтрирани от 2024 г. насам.

Workflow-ът публикува `latest.json`, `weather.json` и `accidents.json` в branch `data`.
