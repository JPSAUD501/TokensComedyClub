// Storage key usado no navegador para identificar o espectador entre sessoes.
export const VIEWER_ID_STORAGE_KEY = "tokenscomedyclub.viewerId";
// Storage key usado no navegador para salvar o passcode do admin localmente.
export const ADMIN_PASSCODE_STORAGE_KEY = "tokenscomedyclub.adminPasscode";

// Quantidade de shards para distribuir contadores de espectadores e reduzir contencao no banco.
export const VIEWER_SHARD_COUNT = 64;
// Tempo maximo sem heartbeat antes de considerar uma sessao de espectador expirada.
export const VIEWER_SESSION_TTL_MS = 30_000;
// Intervalo entre execucoes do reaper que limpa presencas expiradas.
export const VIEWER_REAPER_INTERVAL_MS = 5_000;
// Quantidade padrao de registros processados por rodada do reaper.
export const VIEWER_REAPER_BATCH = 500;
// Limite absoluto de seguranca para o tamanho do batch do reaper.
export const VIEWER_PRESENCE_REAPER_MAX_LIMIT = 1_000;

// Delta minimo para o countdown detectar que a janela mudou (ex: de 120s para 30s).
export const COUNTDOWN_SHORTENED_WINDOW_DETECT_DELTA_MS = 5_000;

// Espera apos rodada pulada por erro antes de seguir para a proxima.
export const SKIPPED_ROUND_DELAY_MS = 10_000;
// Duracao do lease do runner (tempo de posse do loop de execucao).
export const RUNNER_LEASE_MS = 60_000;
// Intervalo do heartbeat automatico que renova o lease durante chamadas longas.
export const RUNNER_LEASE_HEARTBEAT_MS = 20_000;
// Intervalo de renovacao manual do lease durante loops de polling.
export const RUNNER_LEASE_MANUAL_RENEW_MS = 20_000;
// Intervalo base de polling das plataformas externas (Twitch/YouTube).
export const PLATFORM_VIEWER_POLL_INTERVAL_MS = 10_000;
// Timeout de cada chamada individual ao modelo (prompt, answer, vote).
export const MODEL_CALL_TIMEOUT_MS = 60_000;
// Numero total de tentativas por chamada de modelo (1 tentativa + retries).
export const MODEL_ATTEMPTS = 3;
// Delays entre retries de chamadas ao modelo.
export const MODEL_RETRY_BACKOFF_MS = [1_000, 2_000] as const;
// Margem adicional para considerar fase stale apos deadline teorico.
export const MODEL_TIMEOUT_GRACE_MS = 15_000;
// Deadline total da fase de modelo considerando attempts e backoff.
export const MODEL_PHASE_DEADLINE_MS =
  MODEL_ATTEMPTS * MODEL_CALL_TIMEOUT_MS +
  MODEL_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);

// Minimo de modelos ativos para o engine tentar montar uma rodada.
export const ENGINE_RUNNER_MIN_ENABLED_MODELS = 3;
// Intervalo de retry do loop quando o jogo esta pausado.
export const ENGINE_RUNNER_RETRY_PAUSED_MS = 1_000;
// Intervalo de retry quando nao da para rodar (modelos insuficientes/cobertura de papeis).
export const ENGINE_RUNNER_RETRY_BLOCKED_MS = 1_000;
// Retry imediato apos recuperacao bem-sucedida de rodada ativa stale.
export const ENGINE_RUNNER_RETRY_ACTIVE_ROUND_RECOVERED_MS = 0;
// Retry quando existe rodada ativa mas ainda aguardando (nao stale).
export const ENGINE_RUNNER_RETRY_ACTIVE_ROUND_PENDING_MS = 750;
// Retry curto quando falha ao criar nova rodada por condicao concorrente/transiente.
export const ENGINE_RUNNER_RETRY_CREATE_ROUND_FAILED_MS = 300;
// Menor intervalo de polling da janela de voto para evitar busy loop.
export const ENGINE_RUNNER_VOTE_WINDOW_POLL_MIN_MS = 100;
// Maior intervalo de polling da janela de voto para manter responsividade.
export const ENGINE_RUNNER_VOTE_WINDOW_POLL_MAX_MS = 1_000;
// Espera curta para dar tempo de votos de modelos finalizarem no fechamento da janela.
export const ENGINE_RUNNER_VOTE_MODEL_WAIT_MS = 300;

// Tamanho de batch para apagar dados de uma geracao no reset/admin purge.
export const ROUND_PURGE_BATCH_SIZE = 500;
// Tamanho de lote por request na API da Twitch.
export const TWITCH_API_BATCH_SIZE = 100;
// Tamanho de lote por request na API do YouTube.
export const YOUTUBE_API_BATCH_SIZE = 50;
// Timeout da validacao HTTP do Fossabot.
export const FOSSABOT_VALIDATE_TIMEOUT_MS = 5_000;

// Janela de suavizacao para sincronizar estimativa local com atualizacoes remotas de reasoning.
export const REASONING_ESTIMATOR_SYNC_BLEND_MS = 260;
// Limite maximo de extrapolacao sem novos dados de reasoning.
export const REASONING_ESTIMATOR_MAX_EXTRAPOLATION_MS = 900;
// Taxa maxima de crescimento permitida na extrapolacao de reasoning (tokens/ms).
export const REASONING_ESTIMATOR_MAX_RATE_PER_MS = 2.5;
// Tempo para descartar amostras antigas do estimador e evitar crescimento de memoria.
export const REASONING_ESTIMATOR_PRUNE_OLDER_THAN_MS = 3 * 60_000;

// Tick de renderizacao do frontend quando rodada esta em geracao ativa (prompt/answer).
export const FRONTEND_ACTIVE_TICK_MS = 50;
// Tick de renderizacao do frontend quando rodada nao esta em geracao ativa.
export const FRONTEND_IDLE_TICK_MS = 1_000;
// Intervalo de heartbeat do espectador enviado pelo frontend.
export const FRONTEND_VIEWER_HEARTBEAT_MS = 10_000;

// Tick local do estimador no broadcast canvas.
export const BROADCAST_LOCAL_REASONING_TICK_MS = 50;
// FPS padrao da captura de video no broadcast (quando query param nao define).
export const BROADCAST_CAPTURE_DEFAULT_FPS = 30;
// Bitrate padrao da captura de video no broadcast.
export const BROADCAST_CAPTURE_DEFAULT_BITRATE = 12_000_000;
// Intervalo em ms para o MediaRecorder emitir chunks.
export const BROADCAST_CAPTURE_TIMESLICE_MS = 250;
// Buffer maximo de bytes enfileirados para envio de chunks no broadcast.
export const BROADCAST_CAPTURE_MAX_QUEUED_BYTES = 16_000_000;

// URL base da API OpenRouter para consultas de metrica de geracao.
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Backoff progressivo ao consultar dados de generation na OpenRouter.
export const AI_GENERATION_RETRY_DELAYS_MS = [400, 800, 1_200, 1_800, 2_500, 3_500, 5_000] as const;
// Fator inicial de calibracao da estimativa de tokens de reasoning.
export const AI_REASONING_CALIBRATION_DEFAULT_FACTOR = 0.92;
// Limite inferior do fator de calibracao de reasoning.
export const AI_REASONING_CALIBRATION_MIN_FACTOR = 0.45;
// Limite superior do fator de calibracao de reasoning.
export const AI_REASONING_CALIBRATION_MAX_FACTOR = 1.45;
// Quantidade de amostras consideradas fase de aquecimento da calibracao.
export const AI_REASONING_CALIBRATION_WARMUP_SAMPLE_COUNT = 4;
// Alpha usado na media movel da calibracao durante aquecimento (adapta mais rapido).
export const AI_REASONING_CALIBRATION_ALPHA_WARMUP = 0.2;
// Alpha usado na media movel da calibracao apos aquecimento (mais estavel).
export const AI_REASONING_CALIBRATION_ALPHA_STEADY = 0.1;
// Intervalo minimo entre flushes de progresso de reasoning para reduzir ruido.
export const AI_REASONING_PROGRESS_FLUSH_INTERVAL_MS = 1_000;
// Quantidade de prompts de referencia sorteados para compor o system prompt.
export const AI_PROMPT_EXAMPLE_COUNT = 80;
// Tamanho minimo aceitavel de texto para prompt gerado.
export const AI_MIN_PROMPT_LENGTH = 10;
// Tamanho minimo aceitavel de texto para resposta gerada.
export const AI_MIN_ANSWER_LENGTH = 3;
