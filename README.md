# BGTraffic Data Collector v2.4.0

Автоматичен GitHub Actions колектор за BGTraffic.eu.

## Потокове

- БГТОЛ текущ трафик;
- БГТОЛ пътна метеорология;
- МВР ПТП чрез ArcGIS Enterprise portal REST;
- типове МПС от подробните архиви, когато архивът е достъпен.

## Важно във v2.4.0

- МВР колекторът използва портала `https://www.mvr.bg/map/sharing/rest`, открива свързаните Web Maps/Feature Layers и избира само слой с реални записи от 2024 г. насам.
- Историческият слой `PTP_Analysis_WFL1/FeatureServer/3` вече не е твърдо зададен.
- `weather.json` се публикува независимо дали ПТП колекторът е успял.
- `accidents.json` се заменя само при успешно валидиран нов feed.
