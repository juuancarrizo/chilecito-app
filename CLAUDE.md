# Chilecito App — Plataforma deportiva de Chilecito

## Descripción
Plataforma web para buscar y reservar canchas deportivas en Chilecito, La Rioja.
Los usuarios buscan por deporte + fecha + horario y ven las canchas disponibles.
Los dueños tienen panel admin para gestionar sus canchas y marcar horarios ocupados.
Diseñada para escalar más allá del deporte (futura expansión a otros rubros de Chilecito).

## Stack
- **Backend:** Node.js + Express 5 + SQLite (better-sqlite3)
- **Frontend:** HTML/CSS/JS vanilla
- **Deploy:** Railway (pendiente)
- **Repo:** https://github.com/juuancarrizo/chilecito-app (cuenta personal)
- **Volumen Railway:** /data, variable DATA_DIR=/data

## Estructura
```
chilecito-app/
├── backend/server.js         ← API + auth + search + multer
├── frontend/
│   ├── index.html            ← Búsqueda pública por deporte/horario
│   ├── complejo.html         ← Página del complejo (/complejo/:slug)
│   ├── login.html
│   ├── admin/
│   │   ├── index.html        ← Dashboard
│   │   ├── canchas.html      ← CRUD canchas + fotos
│   │   ├── horarios.html     ← Marcar turnos ocupados
│   │   └── config.html       ← Config complejo + amenidades
│   └── css/main.css
├── data/                     ← creado automáticamente (en .gitignore)
├── .gitignore
├── .npmrc
├── nixpacks.toml
└── CLAUDE.md
```

## Correr localmente
```bash
cd ~/Documents/juan/chilecito-app
npm start   # → http://localhost:3003
```

## Deploy
```bash
git add . && git commit -m "descripción"
git push https://juuancarrizo:TOKEN@github.com/juuancarrizo/chilecito-app.git main
```

## Modelo de datos
- **owners** — dueños de complejos
- **venues** — complejos/clubes: owner_id, name, slug, address, phone, whatsapp, cover_image
- **courts** — canchas: venue_id, sport, name, description, surface, covered, wall_material, price_per_hour
- **court_images** — fotos de canchas
- **venue_amenities** — vestuarios, quincho, etc. (bookable=1 si se puede reservar por separado)
- **occupied_slots** — turnos ocupados: court_id, date, start_time, end_time, label

## API pública
- GET /api/search?sport=padel&date=2026-06-05&start_time=20:00&duration=60 → canchas disponibles + sugerencias
- GET /api/venues/:slug → detalle del complejo con canchas y amenidades
- GET /api/sports → deportes disponibles

## Sports válidos
padel | futbol5 | futbol7 | futbol11 | hockey | voley

## Variables Railway
- DATA_DIR=/data
- PORT (automático)

## Decisiones técnicas
- Búsqueda de disponibilidad: query NOT EXISTS en occupied_slots por overlap de horarios
- Sugerencias: si no hay disponible, busca slots a ±3h (saltos de 60 min)
- Un owner = un venue (igual que alojamientos-app)
- node_modules copiado desde kiosko-app (npm install falla en red MeLi)

## Estado al 2026-06-05
- ✅ Búsqueda por deporte + fecha + hora con sugerencias de horarios alternativos
- ✅ CRUD canchas con superficie, techado, pared (pádel), fotos múltiples
- ✅ Gestión de turnos ocupados por fecha/cancha
- ✅ Amenidades del complejo (con opción reservable + precio)
- ✅ Página pública de cada complejo
- ⏳ Deploy Railway: pendiente
- ⏳ Posible expansión: gastronomía, eventos, turismo Chilecito
