import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

// ── Models ──────────────────────────────────────────────────────────────────

const MODELS = [
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
  { id: "moonshotai/kimi-k2", name: "Kimi K2" },
  { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" },
  { id: "openai/gpt-5.2", name: "GPT-5.2" },
  { id: "anthropic/claude-opus-4.6", name: "Opus 4.6" },
  { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
  { id: "x-ai/grok-4.1-fast", name: "Grok 4.1" },
] as const;

type Model = (typeof MODELS)[number];

// ── OpenRouter setup ────────────────────────────────────────────────────────

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

function llm(modelId: string) {
  return openrouter.chat(modelId);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, n);
}

// ── ANSI colors ─────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgMagenta: "\x1b[45m",
  bgBlue: "\x1b[44m",
  bgYellow: "\x1b[43m",
  bgCyan: "\x1b[46m",
};

// Assign each model a consistent color
const MODEL_COLORS = [c.cyan, c.green, c.magenta, c.yellow, c.blue, c.red, c.white];
function modelColor(model: Model): string {
  const idx = MODELS.indexOf(model);
  return MODEL_COLORS[idx % MODEL_COLORS.length];
}

function colorName(model: Model): string {
  return `${c.bold}${modelColor(model)}${model.name}${c.reset}`;
}

function divider() {
  console.log(`${c.dim}${"─".repeat(60)}${c.reset}`);
}

// ── Game logic ──────────────────────────────────────────────────────────────

async function generatePrompt(prompter: Model): Promise<string> {
  process.stdout.write(
    `\n${c.bold}${c.bgMagenta} PROMPT ${c.reset} ${colorName(prompter)} is writing a prompt...`
  );

  const { text } = await generateText({
    model: llm(prompter.id),
    system: `You are a comedy writer for the game Quiplash. Generate a single funny fill-in-the-blank prompt that players will try to answer. The prompt should be surprising and designed to elicit hilarious responses. Return ONLY the prompt text, nothing else. Keep it short (under 15 words).

Use a wide VARIETY of prompt formats. Do NOT always use "The worst thing to..." — mix it up! Here are examples of the range of styles:

- The worst thing to hear from your GPS
- A terrible name for a dog
- A rejected name for a new fast food restaurant
- The worst thing to hear during surgery
- A bad name for a superhero
- A terrible name for a new perfume
- The worst thing to find in your sandwich
- A rejected slogan for a toothpaste brand
- The worst thing to say during a job interview
- A bad name for a country
- The worst thing to say when meeting your partner's parents
- A terrible name for a retirement home
- A rejected title for a romantic comedy
- The world's least popular ice cream flavor
- A terrible fortune cookie message
- What you don't want to hear from your dentist
- The worst name for a band
- A rejected Hallmark card message
- Something you shouldn't yell in a library
- The least intimidating martial arts move

Come up with something ORIGINAL — don't copy these examples.`,
    prompt: "Generate a single original Quiplash prompt. Be creative and don't repeat common patterns.",
    temperature: 1.2,
    maxTokens: 80,
  });

  const prompt = text.trim().replace(/^["']|["']$/g, "");
  console.log(
    `\n\n  ${c.bold}${c.yellow}"${prompt}"${c.reset}\n`
  );
  return prompt;
}

async function generateAnswer(
  contestant: Model,
  prompt: string
): Promise<string> {
  const { text } = await generateText({
    model: llm(contestant.id),
    system: `You are playing Quiplash! You'll be given a fill-in-the-blank prompt. Give the FUNNIEST possible answer. Be creative, edgy, unexpected, and concise. Reply with ONLY your answer — no quotes, no explanation, no preamble. Keep it short (under 12 words).`,
    prompt: `Fill in the blank: ${prompt}`,
    temperature: 1.2,
    maxTokens: 60,
  });

  return text.trim().replace(/^["']|["']$/g, "");
}

async function getVote(
  voter: Model,
  prompt: string,
  answerA: { model: Model; answer: string },
  answerB: { model: Model; answer: string }
): Promise<"A" | "B"> {
  const { text } = await generateText({
    model: llm(voter.id),
    system: `You are a judge in a comedy game. You'll see a fill-in-the-blank prompt and two answers. Pick which answer is FUNNIER. You MUST respond with exactly "A" or "B" — nothing else.`,
    prompt: `Prompt: "${prompt}"\n\nAnswer A: "${answerA.answer}"\nAnswer B: "${answerB.answer}"\n\nWhich is funnier? Reply with just A or B.`,
    temperature: 0.3,
    maxTokens: 5,
  });

  const vote = text.trim().toUpperCase();
  return vote.startsWith("A") ? "A" : "B";
}

async function playRound(
  roundNum: number,
  totalRounds: number,
  scores: Map<string, number>
) {
  console.log(
    `\n${c.bold}${c.bgBlue} ROUND ${roundNum}/${totalRounds} ${c.reset}`
  );
  divider();

  // Pick roles
  const shuffled = shuffle([...MODELS]);
  const prompter = shuffled[0];
  const contestantA = shuffled[1];
  const contestantB = shuffled[2];
  const voters = shuffled.slice(3);

  // 1. Generate prompt
  const prompt = await generatePrompt(prompter);

  // 2. Get answers (in parallel)
  process.stdout.write(
    `${c.dim}  ${contestantA.name} and ${contestantB.name} are thinking...${c.reset}`
  );
  const [answerA, answerB] = await Promise.all([
    generateAnswer(contestantA, prompt),
    generateAnswer(contestantB, prompt),
  ]);
  process.stdout.write("\r\x1b[K"); // clear the "thinking" line

  console.log(`${c.bold}${c.bgCyan} ANSWERS ${c.reset}`);
  console.log(`  ${colorName(contestantA)}  "${c.bold}${answerA}${c.reset}"`);
  console.log(`  ${colorName(contestantB)}  "${c.bold}${answerB}${c.reset}"`);

  // 3. Voting
  console.log(`\n${c.bold}${c.bgYellow}${c.red} VOTES ${c.reset}`);

  const voteResults = await Promise.all(
    voters.map(async (voter) => {
      // Randomize presentation order to avoid position bias
      const showAFirst = Math.random() > 0.5;
      const first = showAFirst
        ? { model: contestantA, answer: answerA }
        : { model: contestantB, answer: answerB };
      const second = showAFirst
        ? { model: contestantB, answer: answerB }
        : { model: contestantA, answer: answerA };

      const vote = await getVote(voter, prompt, first, second);
      // Map back to actual contestant
      const votedFor = showAFirst
        ? vote === "A"
          ? contestantA
          : contestantB
        : vote === "A"
          ? contestantB
          : contestantA;

      return { voter, votedFor };
    })
  );

  // Display votes
  let votesA = 0;
  let votesB = 0;
  for (const { voter, votedFor } of voteResults) {
    const arrow =
      votedFor === contestantA ? colorName(contestantA) : colorName(contestantB);
    console.log(`  ${colorName(voter)} → ${arrow}`);
    if (votedFor === contestantA) votesA++;
    else votesB++;
  }

  // Update scores
  scores.set(
    contestantA.name,
    (scores.get(contestantA.name) ?? 0) + votesA * 100
  );
  scores.set(
    contestantB.name,
    (scores.get(contestantB.name) ?? 0) + votesB * 100
  );

  // Round result
  console.log();
  divider();
  const winner =
    votesA > votesB
      ? contestantA
      : votesB > votesA
        ? contestantB
        : null;

  if (winner) {
    console.log(
      `  ${colorName(winner)} wins! ${c.bold}(${Math.max(votesA, votesB)} votes vs ${Math.min(votesA, votesB)})${c.reset}`
    );
  } else {
    console.log(`  ${c.bold}TIE!${c.reset} (${votesA} - ${votesB})`);
  }

  console.log(
    `  ${colorName(contestantA)} ${c.dim}+${votesA * 100}${c.reset}  |  ${colorName(contestantB)} ${c.dim}+${votesB * 100}${c.reset}`
  );
  divider();
}

function printScoreboard(scores: Map<string, number>) {
  console.log(`\n${c.bold}${c.bgMagenta} FINAL SCORES ${c.reset}\n`);

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const maxScore = sorted[0]?.[1] ?? 0;
  const barWidth = 30;

  for (let i = 0; i < sorted.length; i++) {
    const [name, score] = sorted[i];
    const model = MODELS.find((m) => m.name === name)!;
    const filled = maxScore > 0 ? Math.round((score / maxScore) * barWidth) : 0;
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
    const medal = i === 0 ? " 👑" : i === 1 ? " 🥈" : i === 2 ? " 🥉" : "";
    const color = modelColor(model);

    console.log(
      `  ${c.bold}${i + 1}.${c.reset} ${color}${c.bold}${name.padEnd(16)}${c.reset} ${color}${bar}${c.reset} ${c.bold}${score}${c.reset}${medal}`
    );
  }

  const winner = sorted[0];
  if (winner) {
    const model = MODELS.find((m) => m.name === winner[0])!;
    console.log(
      `\n  ${c.bold}🏆 ${modelColor(model)}${winner[0]}${c.reset}${c.bold} is the funniest AI!${c.reset}\n`
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const runsArg = process.argv.find((a) => a.startsWith("runs="));
  const runs = runsArg ? parseInt(runsArg.split("=")[1], 10) : 5;

  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      `${c.red}${c.bold}Error:${c.reset} Set OPENROUTER_API_KEY environment variable`
    );
    process.exit(1);
  }

  console.log(`\n${c.bold}${c.bgMagenta}  QUIPSLOP  ${c.reset}`);
  console.log(`${c.dim}  AI vs AI comedy showdown — ${runs} rounds${c.reset}`);
  console.log(
    `${c.dim}  Models: ${MODELS.map((m) => m.name).join(", ")}${c.reset}`
  );

  const scores = new Map<string, number>();
  for (const m of MODELS) scores.set(m.name, 0);

  for (let i = 1; i <= runs; i++) {
    await playRound(i, runs, scores);
  }

  printScoreboard(scores);
}

main().catch((err) => {
  console.error(`\n${c.red}${c.bold}Fatal error:${c.reset}`, err);
  process.exit(1);
});
