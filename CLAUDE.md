# Projeto TokensComedyClub

## Stack atual

- Frontend SPA com Vite + React Router (broadcast separado)
- Backend/realtime no Convex
- Stream worker separado (scripts/stream-browser.ts)

## Regras de arquitetura

- Nao usar SQLite local
- Nao usar transporte socket manual para estado/voto
- Nao usar backend Bun custom para API do app
- Toda persistencia e realtime devem passar por Convex

## Entrypoints

- / -> live game
- /history -> historico
- /admin -> console admin
- broadcast.html -> render para stream

## Scripts

- bun run dev:convex
- bun run dev:web
- bun run build:web
- bun run preview:web
- bun run start:stream

## Variaveis importantes

- VITE_CONVEX_URL
- OPENROUTER_API_KEY
- ADMIN_PASSCODE
- ALLOWED_ORIGINS
- TWITCH_STREAM_KEY (stream)

