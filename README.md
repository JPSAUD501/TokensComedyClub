# Tokens Comedy Club 🤖🎭

Jogo de batalha de comédia entre modelos de IA com votação ao vivo do público.

Dois modelos de IA recebem o mesmo tema, geram respostas engraçadas e o público vota no melhor — tudo em tempo real via stream.

## Como funciona

1. **Tema aleatório** é sorteado para cada rodada
2. **Dois modelos** geram respostas simultaneamente (via OpenRouter)
3. **Público vota** no chat (Twitch/YouTube) ou interface web
4. **Placar atualizado** em tempo real
5. **Histórico completo** de todas as batalhas

## Stack

- **Frontend**: Vite + React + TypeScript
- **Backend**: Convex (banco + realtime + HTTP actions)
- **Streaming**: Puppeteer captura canvas → RTMP
- **IA**: OpenRouter (múltiplos modelos)

## Páginas

| Página | URL | Descrição |
|--------|-----|-----------|
| Live | `/` | Acompanha a batalha atual em tempo real |
| Histórico | `/history.html` | Todas as rodadas anteriores |
| Admin | `/admin.html` | Controle de modelos, pausar/resumir, export |
| Broadcast | `/broadcast.html` | Canvas otimizado para captura de stream |

## Rodando local

```bash
# Instalar dependências
bun install

# Configurar variáveis de ambiente (ver exemplos em .env.*.example)
cp .env.web.example .env.web.local
cp .env.convex.example .env.convex.local

# Rodar tudo (web + convex)
bun run dev
```

## Deploy (Coolify)

**Serviço Web:**
- Dockerfile: `Dockerfile`
- Porta: `5109`
- Envs: `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`

**Serviço Stream:**
- Dockerfile: `Dockerfile.stream`
- Envs: `BROADCAST_URL`, `STREAM_RTMP_TARGET`
- Monte a pasta `music/` com faixas `bg_*.mp3`

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `VITE_CONVEX_URL` | Sim | URL do projeto Convex |
| `OPENROUTER_API_KEY` | Sim | API key para gerar respostas IA |
| `ADMIN_PASSCODE` | Sim | Senha para acessar `/admin` |
| `STREAM_RTMP_TARGET` | Stream | URL RTMP (ex: `rtmp://a.rtmp.youtube.com/live2/...`) |

Veja os arquivos `.env.*.example` para a lista completa.

## Votação do público

Integração com chat via HTTP actions:

```
GET /fossabot/vote?vote=1  # Votar na resposta 1
GET /fossabot/vote?vote=2  # Votar na resposta 2
```

Um voto por usuário por rodada (troca permitida).

Guia completo: [`README.fossabot.md`](./README.fossabot.md)

## Scripts úteis

```bash
bun run dev           # Dev com Turbo (web + convex)
bun run dev:web       # Só frontend
bun run dev:convex    # Só backend
bun run build:web     # Build produção
bun run start:stream  # Iniciar stream worker
```

## Licença

MIT
