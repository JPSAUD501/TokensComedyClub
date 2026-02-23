# TokensComedyClub (Convex-Only)

TokensComedyClub e um jogo de batalha de respostas entre modelos de IA com voto humano via chat.
Todo o backend, banco e realtime rodam no Convex.

Sem SQLite, sem Postgres, sem WebSocket manual e sem Railway.

## Arquitetura

- `web`: app Vite (live, history, admin, broadcast canvas)
- `convex`: engine do jogo, storage, realtime, HTTP actions admin e voto Fossabot
- `stream-worker`: abre `/broadcast.html`, captura canvas e envia RTMP

## Requisitos

- Bun 1.3+
- Projeto Convex configurado
- ffmpeg (para `stream-worker`)
- chromium (para `stream-worker`)

## Variaveis de ambiente

As envs configuraveis estao separadas por servico:

- `.env.web.example`
- `.env.convex.example`
- `.env.stream.example`

### Web client

- `VITE_CONVEX_URL` (obrigatoria)
- `VITE_CONVEX_SITE_URL` (obrigatoria para `/admin/*`)

### Convex backend

- `OPENROUTER_API_KEY` (obrigatoria para o engine gerar prompt/resposta/voto IA)
- `ADMIN_PASSCODE` (obrigatoria para `/admin/*`)
- `ALLOWED_ORIGINS` (opcional, default `*`)
- `FOSSABOT_VALIDATE_REQUESTS` (opcional, default `true`)

### Integracoes de audiencia real

- `TWITCH_CLIENT_ID` (obrigatoria se usar targets Twitch)
- `TWITCH_CLIENT_SECRET` (obrigatoria se usar targets Twitch)
- `YOUTUBE_API_KEY` (obrigatoria se usar targets YouTube)
- `PLATFORM_VIEWER_POLL_INTERVAL_MS` (opcional, default `10000`)

### Stream worker

- `STREAM_RTMP_TARGET` (obrigatoria em modo live)
- `BROADCAST_URL` (recomendado; no Coolify: `http://web:5109/broadcast.html`)

## Setup local

1. Instalar dependencias:

```bash
bun install
```

2. Configurar envs:
- web: copie de `.env.web.example`
- convex: copie de `.env.convex.example`
- stream-worker: copie de `.env.stream.example`

3. Rodar Convex:

```bash
bun run dev:convex
```

4. Rodar web:

```bash
bun run dev:web
```

Ou rodar os dois com Turbo:

```bash
bun run dev
```

`bun run dev` usa o TUI do Turborepo no console (configurado em `turbo.json`).

## Paginas

- `/index.html` live
- `/history.html` historico
- `/admin.html` admin
- `/broadcast.html` canvas para stream

## Admin HTTP Actions (Convex)

- `POST /admin/login`
- `GET /admin/status`
- `GET /admin/models`
- `POST /admin/models` (cria ou restaura arquivado)
- `POST /admin/models/update` (edita modelo existente)
- `POST /admin/models/enable`
- `POST /admin/models/remove` (arquiva)
- `POST /admin/models/restore` (desarquiva)
- `GET /admin/viewer-targets`
- `POST /admin/viewer-targets`
- `POST /admin/viewer-targets/delete`
- `POST /admin/pause`
- `POST /admin/resume`
- `POST /admin/reset`
- `GET /admin/export`

Auth: header `x-admin-passcode`.

## Votacao da plateia (Fossabot)

Votos humanos entram por:

- `GET /fossabot/vote?vote=1`
- `GET /fossabot/vote?vote=2`

Regra: 1 voto por usuario por rodada, com troca permitida.

Guia completo: `README.fossabot.md`

## Contagem de espectadores e janela de voto

Contagem exibida:

- `web (live/history nao-ghost) + soma de todos os targets ativos Twitch/YouTube`
- `/broadcast.html` nao envia heartbeat e nunca entra na contagem

Regra da janela humana:

- sem audiencia real: 120s
- com audiencia real: 30s
- se entrar audiencia durante janela longa, encurta imediatamente para 30s
- se restar menos de 30s, mantem o tempo restante

`?ghost=true` continua disponivel para live/history quando quiser abrir paginas sem contar presenca.

## Stream worker

Live:

```bash
bun run start:stream
```

Dry run local:

```bash
bun run start:stream:dryrun
```

### Musica de fundo

Coloque faixas em `music/` com nome:

- `bg_1.mp3`
- `bg_2.mp3`
- `bg_3.mp3`
- `bg_4.mp3`

Suporta mais faixas (`bg_5.mp3`, etc). O worker monta playlist aleatoria e toca em loop continuo.

## Build

```bash
bun run build:web
bun run preview:web
```

## Deploy (Coolify, 2 servicos)

1. `web`
- Dockerfile: `Dockerfile`
- Porta: `5109`
- Env minima: `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`

2. `stream-worker`
- Dockerfile: `Dockerfile.stream`
- Sem porta publica obrigatoria
- Env minima: `BROADCAST_URL`, `STREAM_RTMP_TARGET`
- Montar pasta `music/` com as faixas `bg_*.mp3`

## Scripts disponiveis

- `bun run dev:convex`
- `bun run dev:web`
- `bun run dev` (Turbo TUI: web + convex)
- `bun run build:web`
- `bun run preview:web`
- `bun run start` (preview web)
- `bun run start:stream`
- `bun run start:stream:dryrun`
