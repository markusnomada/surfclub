# Surf Club

App web del club para subir videos de surf con los datos de la sesión, comentarios generales y de mejora (coach), y ver la evolución de cada surfista en una línea de tiempo y una pizarra de clips en loop.

## Arquitectura

- **Cloudflare Pages**: sirve `public/` (HTML/JS sin build) y la API en `functions/api/`.
- **D1** (`surfclub`): miembros, picos, tablas, videos, comentarios. Esquema en `migrations/`.
- **R2** (`surfclub-videos`): video original, clip en loop (~4 s, 480 px, sin audio) y poster. Sin costo de transferencia.
- **Cloudflare Access**: login por correo (código de un solo uso). La API verifica el JWT de Access y que el correo esté en `members`.
- **Open-Meteo**: oleaje, swell, viento y marea modelada para el pico y la hora del video (gratis, sin clave).
- **Detección de toma lejana**: en el navegador con TensorFlow.js (COCO-SSD). Mide el alto del surfista respecto al cuadro y marca `small`, `not_detected` o `low_quality`.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars   # DEV_USER simula el login
npm run db:local
npm run dev                      # http://localhost:8788
```
