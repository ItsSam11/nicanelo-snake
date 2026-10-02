import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReplayCorpus,
  parseOfficialReplayJsonl,
  serializeOfficialReplay,
  supportedInitialSnakeCount,
  validateChampionshipReplay,
  type ReplaySummary,
} from "./replay-corpus.js";

export interface SnakeEndpoint {
  name: string;
  url: string;
}

export interface BatchOptions {
  games: number;
  gameAttempts?: number;
  baseSeed: number;
  gameIndexOffset?: number;
  outputDirectory: string;
  runId: string;
  timeoutMs: number;
  battlesnakeBinary: string;
  snakes: readonly SnakeEndpoint[];
  provenanceFile?: string;
  modelVersions?: readonly string[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface BatchManifestEntry {
  seed: number;
  snakeOrder: string[];
  attempts?: number;
  recordFile?: string;
  summaryFile?: string;
  observationsFile?: string;
  success: boolean;
  summary?: ReplaySummary;
  error?: string;
}

export function rotateSnakeEndpoints(
  snakes: readonly SnakeEndpoint[],
  gameIndex: number,
): SnakeEndpoint[] {
  if (snakes.length === 0) return [];
  if (!Number.isSafeInteger(gameIndex) || gameIndex < 0) {
    throw new Error("gameIndex must be a non-negative safe integer");
  }
  const offset = gameIndex % snakes.length;
  return [...snakes.slice(offset), ...snakes.slice(0, offset)];
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function safeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a safe integer`);
  }
  return parsed;
}

function parseSnake(value: string): SnakeEndpoint {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--snake must use the form "Name=http://host:port"');
  }
  const name = value.slice(0, separator).trim();
  const url = value.slice(separator + 1).trim();
  const parsed = new URL(url);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("Snake URLs must use http or https");
  }
  return { name, url: parsed.toString().replace(/\/$/u, "") };
}

function safeComponent(value: string, flag: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`${flag} contains unsupported characters`);
  }
  return value;
}

function defaultRunId(): string {
  return `local-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
}

export function parseBatchOptions(argv: readonly string[]): BatchOptions {
  const options: BatchOptions = {
    games: 10,
    baseSeed: Math.floor(Date.now() / 1_000),
    outputDirectory: "",
    runId: "",
    timeoutMs: 500,
    battlesnakeBinary: "battlesnake",
    snakes: [],
  };
  const snakes: SnakeEndpoint[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    switch (flag) {
      case "--games":
        options.games = positiveInteger(value, flag);
        break;
      case "--base-seed":
        options.baseSeed = safeInteger(value, flag);
        break;
      case "--attempts":
        options.gameAttempts = positiveInteger(value, flag);
        break;
      case "--output":
        options.outputDirectory = value;
        break;
      case "--run-id":
        options.runId = safeComponent(value, flag);
        break;
      case "--timeout":
        options.timeoutMs = positiveInteger(value, flag);
        break;
      case "--battlesnake-bin":
        options.battlesnakeBinary = value;
        break;
      case "--provenance":
        options.provenanceFile = value;
        break;
      case "--snake":
        snakes.push(parseSnake(value));
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }

  if (!supportedInitialSnakeCount(snakes.length)) {
    throw new Error(
      "The Elaniin championship harness requires between two and four snakes",
    );
  }
  const runId = options.runId || defaultRunId();
  return {
    ...options,
    runId,
    outputDirectory: options.outputDirectory ||
      join("data/telemetry/raw/gym", runId),
    snakes,
  };
}

export function buildBattlesnakeArguments(
  options: Readonly<BatchOptions>,
  seed: number,
  replayPath: string,
  gameIndex = 0,
): string[] {
  const args = [
    "play",
    "--width",
    "11",
    "--height",
    "11",
    "--gametype",
    "standard",
    "--map",
    "standard",
    "--timeout",
    String(options.timeoutMs),
    "--seed",
    String(seed),
    "--output",
    replayPath,
  ];
  for (const snake of rotateSnakeEndpoints(options.snakes, gameIndex)) {
    args.push("--name", snake.name, "--url", snake.url);
  }
  return args;
}

function boundedOutput(current: string, chunk: Buffer): string {
  const maximum = 64_000;
  const combined = current + chunk.toString("utf8");
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

function runCommand(binary: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + "\n";
}

async function runGame(
  options: Readonly<BatchOptions>,
  seed: number,
  gameIndex: number,
): Promise<BatchManifestEntry> {
  const stagingPath = join(options.outputDirectory, `.game-${seed}.jsonl`);
  const snakes = rotateSnakeEndpoints(options.snakes, gameIndex);
  const snakeOrder = snakes.map((snake) => snake.name);
  const command = buildBattlesnakeArguments(
    { ...options, snakes },
    seed,
    stagingPath,
  );
  const result = await runCommand(options.battlesnakeBinary, command);
  if (result.exitCode !== 0) {
    await unlink(stagingPath).catch(() => undefined);
    return {
      seed,
      snakeOrder,
      success: false,
      error: result.stderr.trim() || result.stdout.trim() ||
        `battlesnake exited with code ${result.exitCode}`,
    };
  }

  try {
    const replay = parseOfficialReplayJsonl(
      await readFile(stagingPath, "utf8"),
    );
    validateChampionshipReplay(replay);
    const corpus = buildReplayCorpus(replay, {
      source: "gym",
      runId: options.runId,
      seed,
      ...(options.modelVersions === undefined
        ? {}
        : { modelVersions: options.modelVersions }),
    });
    const gameDirectory = join(options.outputDirectory, replay.metadata.id);
    const recordPath = join(gameDirectory, "record.jsonl");
    const summaryPath = join(gameDirectory, "summary.json");
    const observationsPath = join(gameDirectory, "observations.jsonl");
    await mkdir(gameDirectory, { recursive: true });
    await Promise.all([
      writeFile(recordPath, serializeOfficialReplay(replay), { flag: "wx" }),
      writeFile(
        summaryPath,
        `${JSON.stringify(corpus.summary, null, 2)}\n`,
        { flag: "wx" },
      ),
      writeFile(observationsPath, jsonLines(corpus.observations), {
        flag: "wx",
      }),
    ]);

    return {
      seed,
      snakeOrder,
      recordFile: `${replay.metadata.id}/${basename(recordPath)}`,
      summaryFile: `${replay.metadata.id}/${basename(summaryPath)}`,
      observationsFile: `${replay.metadata.id}/${basename(observationsPath)}`,
      success: true,
      summary: corpus.summary,
    };
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

export async function runBatch(options: Readonly<BatchOptions>): Promise<void> {
  if (!supportedInitialSnakeCount(options.snakes.length)) {
    throw new Error(
      "The Elaniin championship harness requires between two and four snakes",
    );
  }
  const gameAttempts = options.gameAttempts ?? 1;
  if (!Number.isSafeInteger(gameAttempts) || gameAttempts < 1) {
    throw new Error("gameAttempts must be a positive integer");
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const manifestPath = join(options.outputDirectory, "manifest.jsonl");
  const { provenanceFile, ...portableOptions } = options;
  const provenance = provenanceFile === undefined
    ? undefined
    : parseRunProvenance(await readFile(provenanceFile, "utf8"));
  await writeFile(
    join(options.outputDirectory, "run.json"),
    `${JSON.stringify({
      ...portableOptions,
      ...(provenance === undefined ? {} : { provenance }),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(manifestPath, "", { flag: "wx" });

  let failures = 0;
  for (let index = 0; index < options.games; index += 1) {
    const seed = options.baseSeed + index;
    const gameIndex = (options.gameIndexOffset ?? 0) + index;
    let entry: BatchManifestEntry | undefined;
    for (let attempt = 1; attempt <= gameAttempts; attempt += 1) {
      try {
        entry = await runGame(options, seed, gameIndex);
      } catch (error) {
        entry = {
          seed,
          snakeOrder: rotateSnakeEndpoints(options.snakes, gameIndex).map(
            (snake) => snake.name,
          ),
          success: false,
          error: error instanceof Error ? error.message : "Unknown batch error",
        };
      }
      entry.attempts = attempt;
      if (entry.success || attempt === gameAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
    if (entry === undefined) throw new Error(`Game ${seed} did not run`);
    if (!entry.success) failures += 1;
    await appendFile(manifestPath, `${JSON.stringify(entry)}\n`);
    console.log(JSON.stringify({ event: "gym_game", ...entry }));
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${options.games} gym games failed`);
  }
}

export function parseRunProvenance(input: string): Record<string, unknown> {
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Run provenance must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  await runBatch(parseBatchOptions(process.argv.slice(2)));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
