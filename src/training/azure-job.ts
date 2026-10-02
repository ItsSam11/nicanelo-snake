import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import type {
  MoveTelemetryRecord,
  PersistenceRecord,
} from "../persistence/types.js";
import {
  runBatch,
  type BatchOptions,
  type SnakeEndpoint,
} from "./batch-tournament.js";
import type { ReplaySummary } from "./replay-corpus.js";
import {
  PUCT_POLICY_TARGET_VERSION,
  puctPolicyTargets,
  serializePuctPolicyTargets,
} from "./search-targets.js";
import { parseTelemetryJson } from "./telemetry-corpus.js";

const SNAKES_PER_LANE = 4;

export interface LanePlan {
  lane: number;
  games: number;
  baseSeed: number;
  gameIndexOffset: number;
  startPort: number;
}

interface AzureJobOptions {
  games: number;
  gameAttempts: number;
  lanes: number;
  baseSeed: number;
  gameIndexOffset: number;
  startPort: number;
  timeoutMs: number;
  searchWorkers: number;
  searchBudgetMs: number;
  responseReserveMs: number;
  runId: string;
  outputDirectory: string;
  battlesnakeBinary: string;
  zooServerBinary: string;
  zooServerPort: number;
  serverScript: string;
  uploadEnabled: boolean;
  uploadConcurrency: number;
  storageAccountUrl?: string;
  storageContainer: string;
  storagePrefix: string;
  opponents: readonly SnakeEndpoint[];
  subjectModelVersion: string;
  provenance: Readonly<Record<string, unknown>>;
}

interface ManagedProcess {
  child: ChildProcess;
  stderr: () => string;
}

interface ManagedServer extends ManagedProcess {
  port: number;
  telemetryFile: string;
}

interface ManifestEntry {
  seed: number;
  success: boolean;
  summary?: ReplaySummary;
  error?: string;
}

interface SearchTargetCounts {
  total: number;
  eligible: number;
  excluded: number;
}

function integerFromEnvironment(
  name: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function booleanFromEnvironment(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function safeComponent(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return value;
}

function defaultRunId(): string {
  return `azure-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
}

function jsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseJobOpponents(value: string): SnakeEndpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("JOB_OPPONENTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== SNAKES_PER_LANE - 1) {
    throw new Error("JOB_OPPONENTS_JSON must contain exactly three opponents");
  }
  const opponents = parsed.map((item, index): SnakeEndpoint => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`JOB_OPPONENTS_JSON[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.name !== "string" || candidate.name.trim().length === 0 ||
      typeof candidate.url !== "string"
    ) {
      throw new Error(
        `JOB_OPPONENTS_JSON[${index}] requires non-empty name and url`,
      );
    }
    const url = new URL(candidate.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`JOB_OPPONENTS_JSON[${index}].url must use HTTP(S)`);
    }
    return {
      name: candidate.name.trim(),
      url: url.toString().replace(/\/$/u, ""),
    };
  });
  if (new Set(opponents.map((item) => item.name)).size !== opponents.length) {
    throw new Error("JOB_OPPONENTS_JSON opponent names must be unique");
  }
  if (new Set(opponents.map((item) => item.url)).size !== opponents.length) {
    throw new Error("JOB_OPPONENTS_JSON opponent URLs must be unique");
  }
  return opponents;
}

export function parseAzureJobOptions(): AzureJobOptions {
  const games = integerFromEnvironment("JOB_GAMES", 10);
  const lanes = integerFromEnvironment("JOB_LANES", 2);
  if (lanes > games) {
    throw new Error("JOB_LANES cannot exceed JOB_GAMES");
  }
  const runId = safeComponent(
    process.env.JOB_RUN_ID ?? defaultRunId(),
    "JOB_RUN_ID",
  );
  const uploadEnabled = booleanFromEnvironment("JOB_UPLOAD_ENABLED", false);
  const storageAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (uploadEnabled && storageAccountUrl === undefined) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_URL is required when JOB_UPLOAD_ENABLED=true",
    );
  }
  const opponentsJson = process.env.JOB_OPPONENTS_JSON;
  if (opponentsJson === undefined) {
    throw new Error("JOB_OPPONENTS_JSON is required");
  }
  const provenanceJson = process.env.JOB_PROVENANCE_JSON;
  if (provenanceJson === undefined) {
    throw new Error("JOB_PROVENANCE_JSON is required");
  }
  const subjectModelVersionValue = process.env.JOB_SUBJECT_MODEL_VERSION;
  if (
    subjectModelVersionValue === undefined ||
    subjectModelVersionValue.length === 0
  ) {
    throw new Error("JOB_SUBJECT_MODEL_VERSION is required");
  }
  const subjectModelVersion = safeComponent(
    subjectModelVersionValue,
    "JOB_SUBJECT_MODEL_VERSION",
  );

  return {
    games,
    gameAttempts: integerFromEnvironment("JOB_GAME_ATTEMPTS", 3),
    lanes,
    baseSeed: integerFromEnvironment("JOB_BASE_SEED", 2_026_092_200, 0),
    gameIndexOffset: integerFromEnvironment("JOB_GAME_INDEX_OFFSET", 0, 0),
    startPort: integerFromEnvironment("JOB_START_PORT", 8_101),
    timeoutMs: integerFromEnvironment("JOB_GAME_TIMEOUT_MS", 500),
    searchWorkers: integerFromEnvironment("SEARCH_WORKERS", 4),
    searchBudgetMs: integerFromEnvironment("SEARCH_TIME_BUDGET_MS", 150, 0),
    responseReserveMs: integerFromEnvironment(
      "SEARCH_RESPONSE_RESERVE_MS",
      100,
      0,
    ),
    runId,
    outputDirectory: process.env.JOB_OUTPUT_DIRECTORY ??
      join("/tmp/battlesnake-corpus", runId),
    battlesnakeBinary: process.env.BATTLESNAKE_BINARY ??
      "/usr/local/bin/battlesnake",
    zooServerBinary: process.env.JOB_ZOO_SERVER_BINARY ??
      "/usr/local/bin/coreyja-zoo",
    zooServerPort: integerFromEnvironment("JOB_ZOO_SERVER_PORT", 8_200),
    serverScript: process.env.JOB_SERVER_SCRIPT ??
      fileURLToPath(new URL("../index.js", import.meta.url)),
    uploadEnabled,
    uploadConcurrency: integerFromEnvironment("JOB_UPLOAD_CONCURRENCY", 8),
    ...(storageAccountUrl === undefined ? {} : { storageAccountUrl }),
    storageContainer: process.env.AZURE_STORAGE_CONTAINER ??
      "battlesnake-corpus",
    storagePrefix: process.env.JOB_STORAGE_PREFIX ??
      `telemetry/raw/gym/${runId}`,
    opponents: parseJobOpponents(opponentsJson),
    subjectModelVersion,
    provenance: jsonObject(provenanceJson, "JOB_PROVENANCE_JSON"),
  };
}

export function laneSnakeEndpoints(
  plan: Readonly<LanePlan>,
  opponents: readonly SnakeEndpoint[],
): SnakeEndpoint[] {
  if (opponents.length !== SNAKES_PER_LANE - 1) {
    throw new Error("A zoo lane requires exactly three opponents");
  }
  return [
    { name: "Nicanelo", url: `http://127.0.0.1:${plan.startPort}` },
    ...opponents,
  ];
}

export function partitionBatchGames(
  games: number,
  lanes: number,
  baseSeed: number,
  startPort = 8_101,
  gameIndexOffset = 0,
): LanePlan[] {
  if (!Number.isSafeInteger(games) || games < 1) {
    throw new Error("games must be a positive integer");
  }
  if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > games) {
    throw new Error("lanes must be between one and games");
  }
  if (!Number.isSafeInteger(gameIndexOffset) || gameIndexOffset < 0) {
    throw new Error("gameIndexOffset must be a non-negative integer");
  }

  const minimumLaneSize = Math.floor(games / lanes);
  const extraGames = games % lanes;
  let seedOffset = 0;
  return Array.from({ length: lanes }, (_, lane) => {
    const laneGames = minimumLaneSize + (lane < extraGames ? 1 : 0);
    const plan = {
      lane,
      games: laneGames,
      baseSeed: baseSeed + seedOffset,
      gameIndexOffset: gameIndexOffset + seedOffset,
      startPort: startPort + lane * SNAKES_PER_LANE,
    };
    seedOffset += laneGames;
    return plan;
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedOutput(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length <= 16_000 ? combined : combined.slice(-16_000);
}

async function waitForServer(server: ManagedServer): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Snake server on port ${server.port} exited early: ${server.stderr()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      if (response.ok) return;
    } catch {
      // The process may still be loading the model and starting its workers.
    }
    await sleep(100);
  }
  throw new Error(`Snake server on port ${server.port} was not ready in time`);
}

async function waitForOpponent(opponent: Readonly<SnakeEndpoint>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(opponent.url);
      if (response.ok) return;
    } catch {
      // The isolated internal Zoo app may still be scaling up from zero.
    }
    await sleep(100);
  }
  throw new Error(`Zoo opponent ${opponent.name} was not ready at ${opponent.url}`);
}

function startZooServer(
  options: Readonly<AzureJobOptions>,
): ManagedProcess {
  let stderr = "";
  const child = spawn(options.zooServerBinary, [], {
    env: {
      ...process.env,
      PORT: String(options.zooServerPort),
      JSON_LOGS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = boundedOutput(stderr, chunk);
  });
  return { child, stderr: () => stderr };
}

export function serverTelemetryPath(
  outputDirectory: string,
  plan: Readonly<LanePlan>,
): string {
  return join(
    outputDirectory,
    "_telemetry",
    `lane-${String(plan.lane + 1).padStart(2, "0")}`,
    "nicanelo.jsonl",
  );
}

function startServer(
  plan: Readonly<LanePlan>,
  options: Readonly<AzureJobOptions>,
): ManagedServer {
  const port = plan.startPort;
  const telemetryFile = serverTelemetryPath(options.outputDirectory, plan);
  let stderr = "";
  const child = spawn(process.execPath, [options.serverScript], {
    env: {
      ...process.env,
      PORT: String(port),
      SEARCH_WORKERS: String(options.searchWorkers),
      SEARCH_TIME_BUDGET_MS: String(options.searchBudgetMs),
      SEARCH_RESPONSE_RESERVE_MS: String(options.responseReserveMs),
      REDIS_ENABLED: "false",
      AZURE_BLOB_ENABLED: "false",
      FILE_TELEMETRY_PATH: telemetryFile,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = boundedOutput(stderr, chunk);
  });
  return { child, port, telemetryFile, stderr: () => stderr };
}

export async function stopProcess(process: ManagedProcess): Promise<void> {
  if (
    process.child.exitCode !== null ||
    process.child.signalCode !== null
  ) return;
  const exited = once(process.child, "exit").then(() => true);
  process.child.kill("SIGTERM");
  if (await Promise.race([exited, sleep(5_000).then(() => false)])) return;
  process.child.kill("SIGKILL");
  await exited;
}

function laneBatchOptions(
  plan: Readonly<LanePlan>,
  options: Readonly<AzureJobOptions>,
): BatchOptions {
  return {
    games: plan.games,
    gameAttempts: options.gameAttempts,
    baseSeed: plan.baseSeed,
    gameIndexOffset: plan.gameIndexOffset,
    outputDirectory: join(
      options.outputDirectory,
      `lane-${String(plan.lane + 1).padStart(2, "0")}`,
    ),
    runId: options.runId,
    timeoutMs: options.timeoutMs,
    battlesnakeBinary: options.battlesnakeBinary,
    snakes: laneSnakeEndpoints(plan, options.opponents),
    provenanceFile: join(options.outputDirectory, "provenance.json"),
    modelVersions: [options.subjectModelVersion],
  };
}

async function readManifest(path: string): Promise<ManifestEntry[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ManifestEntry);
}

function parseTelemetryJsonl(text: string, path: string): PersistenceRecord[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      try {
        return [parseTelemetryJson(line)];
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid telemetry";
        throw new Error(`${path}:${index + 1}: ${detail}`);
      }
    });
}

export function assertTelemetryModelVersion(
  records: readonly Readonly<Pick<PersistenceRecord, "modelVersion">>[],
  expectedModelVersion: string,
): void {
  const observed = [...new Set(records.map((record) => record.modelVersion))]
    .sort();
  if (
    observed.length !== 1 ||
    observed[0] !== expectedModelVersion
  ) {
    throw new Error(
      `Telemetry model mismatch: expected ${expectedModelVersion}, ` +
        `observed ${observed.length === 0 ? "none" : observed.join(",")}`,
    );
  }
}

async function materializeSearchTargets(
  plans: readonly LanePlan[],
  servers: readonly ManagedServer[],
  options: Readonly<AzureJobOptions>,
): Promise<SearchTargetCounts> {
  const records = (
    await Promise.all(
      servers.map(async (server) =>
        parseTelemetryJsonl(
          await readFile(server.telemetryFile, "utf8"),
          server.telemetryFile,
        )
      ),
    )
  ).flat();
  assertTelemetryModelVersion(records, options.subjectModelVersion);
  const movesByGame = new Map<string, MoveTelemetryRecord[]>();
  for (const record of records) {
    if (record.event !== "move") continue;
    const moves = movesByGame.get(record.gameId) ?? [];
    moves.push(record);
    movesByGame.set(record.gameId, moves);
  }

  const counts: SearchTargetCounts = { total: 0, eligible: 0, excluded: 0 };
  for (const plan of plans) {
    const laneName = `lane-${String(plan.lane + 1).padStart(2, "0")}`;
    const laneDirectory = join(options.outputDirectory, laneName);
    const entries = await readManifest(join(laneDirectory, "manifest.jsonl"));
    const targetManifest: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (!entry.success || entry.summary === undefined) continue;
      const gameId = entry.summary.gameId;
      const moveRecords = movesByGame.get(gameId) ?? [];
      if (moveRecords.length === 0) {
        throw new Error(`No move telemetry was captured for game ${gameId}`);
      }
      const targets = puctPolicyTargets(moveRecords, {
        winnerId: entry.summary.winnerId,
        winnerName: entry.summary.winnerName,
        isDraw: entry.summary.isDraw,
      });
      const eligible = targets.filter((target) => target.policyEligible).length;
      const relativeTargetFile = `${gameId}/search-observations.jsonl`;
      await writeFile(
        join(laneDirectory, relativeTargetFile),
        serializePuctPolicyTargets(targets),
        { flag: "wx" },
      );
      targetManifest.push({
        gameId,
        targetVersion: PUCT_POLICY_TARGET_VERSION,
        searchObservationsFile: relativeTargetFile,
        totalTargets: targets.length,
        eligibleTargets: eligible,
        excludedTargets: targets.length - eligible,
      });
      counts.total += targets.length;
      counts.eligible += eligible;
      counts.excluded += targets.length - eligible;
      movesByGame.delete(gameId);
    }
    await writeFile(
      join(laneDirectory, "search-manifest.jsonl"),
      targetManifest.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      { flag: "wx" },
    );
  }
  return counts;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

async function summarizeRun(
  plans: readonly LanePlan[],
  options: Readonly<AzureJobOptions>,
  searchTargets: Readonly<SearchTargetCounts>,
): Promise<Record<string, unknown>> {
  const entries = (
    await Promise.all(
      plans.map((plan) =>
        readManifest(
          join(
            options.outputDirectory,
            `lane-${String(plan.lane + 1).padStart(2, "0")}`,
            "manifest.jsonl",
          ),
        )
      ),
    )
  ).flat();
  const failures = entries.filter((entry) => !entry.success);
  const summaries = entries.flatMap((entry) =>
    entry.summary === undefined ? [] : [entry.summary]
  );
  const seeds = new Set(entries.map((entry) => entry.seed));
  const gameIds = new Set(summaries.map((summary) => summary.gameId));
  if (
    failures.length > 0 ||
    entries.length !== options.games ||
    summaries.length !== options.games ||
    seeds.size !== options.games ||
    gameIds.size !== options.games
  ) {
    throw new Error(
      `Invalid batch: entries=${entries.length}, summaries=${summaries.length}, ` +
        `uniqueSeeds=${seeds.size}, uniqueGameIds=${gameIds.size}, ` +
        `failures=${failures.length}`,
    );
  }

  const finalTurns = summaries.map((summary) => summary.finalTurn);
  const eliminations = summaries.flatMap((summary) => summary.eliminations)
    .flatMap((entry) =>
      entry.eliminatedOnTurn === undefined ? [] : [entry.eliminatedOnTurn]
    );
  const latency = summaries.flatMap((summary) => summary.latency);
  const winners = new Map<string, number>();
  for (const summary of summaries) {
    const winner = summary.isDraw ? "draw" : summary.winnerName;
    winners.set(winner, (winners.get(winner) ?? 0) + 1);
  }

  return {
    runId: options.runId,
    roster: ["Nicanelo", ...options.opponents.map((item) => item.name)],
    subjectModelVersion: options.subjectModelVersion,
    provenance: options.provenance,
    games: entries.length,
    lanes: options.lanes,
    baseSeed: options.baseSeed,
    gameIndexOffset: options.gameIndexOffset,
    uniqueSeeds: seeds.size,
    uniqueGameIds: gameIds.size,
    draws: summaries.filter((summary) => summary.isDraw).length,
    finalTurns: {
      minimum: Math.min(...finalTurns),
      p50: percentile(finalTurns, 0.5),
      p95: percentile(finalTurns, 0.95),
      maximum: Math.max(...finalTurns),
    },
    eliminations: {
      total: eliminations.length,
      throughTurn10: eliminations.filter((turn) => turn <= 10).length,
      throughTurn20: eliminations.filter((turn) => turn <= 20).length,
      throughTurn50: eliminations.filter((turn) => turn <= 50).length,
      firstTurn: eliminations.length === 0 ? null : Math.min(...eliminations),
    },
    latency: {
      worstSnakeP95Ms: latency.length === 0
        ? 0
        : Math.max(...latency.map((entry) => entry.p95Ms)),
      maximumMs: latency.length === 0
        ? 0
        : Math.max(...latency.map((entry) => entry.maxMs)),
    },
    winners: Object.fromEntries(
      [...winners.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    searchTargets: {
      version: PUCT_POLICY_TARGET_VERSION,
      ...searchTargets,
    },
  };
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) {
      files.push(...await filesBelow(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

async function mapConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const item = items[nextIndex];
          nextIndex += 1;
          if (item === undefined) continue;
          try {
            await operation(item);
          } catch (error) {
            failures.push(error);
          }
        }
      },
    ),
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} concurrent operations failed`,
    );
  }
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

async function retry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function uploadOutput(options: Readonly<AzureJobOptions>): Promise<number> {
  if (!options.uploadEnabled || options.storageAccountUrl === undefined) return 0;
  const files = (await filesBelow(options.outputDirectory)).sort((a, b) =>
    a.localeCompare(b)
  );
  const successMarker = join(options.outputDirectory, "summary.json");
  const failureMarker = join(options.outputDirectory, "failure.json");
  const marker = files.includes(successMarker)
    ? successMarker
    : files.includes(failureMarker)
    ? failureMarker
    : undefined;
  if (marker === undefined) {
    throw new Error("Job output has no summary.json or failure.json marker");
  }
  console.log(JSON.stringify({
    event: "azure_job_upload_started",
    runId: options.runId,
    files: files.length,
    concurrency: options.uploadConcurrency,
    storagePrefix: options.storagePrefix,
  }));

  const service = new BlobServiceClient(
    options.storageAccountUrl,
    new DefaultAzureCredential(),
  );
  const container = service.getContainerClient(options.storageContainer);
  await container.createIfNotExists();
  const uploadFile = async (file: string): Promise<void> => {
    const relativePath = relative(options.outputDirectory, file)
      .split(sep)
      .join("/");
    const blobName = `${options.storagePrefix}/${relativePath}`;
    const client = container.getBlockBlobClient(blobName);
    const localSize = (await stat(file)).size;
    await retry(async () => {
      try {
        await client.uploadFile(file, { conditions: { ifNoneMatch: "*" } });
      } catch (error) {
        if (errorStatusCode(error) !== 412) throw error;
        const properties = await client.getProperties();
        if (properties.contentLength !== localSize) {
          throw new Error(
            `Existing Blob has the wrong size: ${blobName} ` +
            `(local=${localSize}, remote=${properties.contentLength ?? "unknown"})`,
          );
        }
      }
    });
  };
  await mapConcurrent(
    files.filter((file) => file !== marker),
    options.uploadConcurrency,
    uploadFile,
  );
  await uploadFile(marker);

  const markerName = `${options.storagePrefix}/${
    relative(options.outputDirectory, marker).split(sep).join("/")
  }`;
  if (!await container.getBlockBlobClient(markerName).exists()) {
    throw new Error(`Upload marker was not persisted: ${markerName}`);
  }
  console.log(JSON.stringify({
    event: "azure_job_upload_complete",
    runId: options.runId,
    files: files.length,
    marker: markerName,
  }));
  return files.length;
}

async function runAzureJob(): Promise<void> {
  const options = parseAzureJobOptions();
  const plans = partitionBatchGames(
    options.games,
    options.lanes,
    options.baseSeed,
    options.startPort,
    options.gameIndexOffset,
  );
  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(
    join(options.outputDirectory, "job.json"),
    `${JSON.stringify({
      runId: options.runId,
      games: options.games,
      gameAttempts: options.gameAttempts,
      lanes: options.lanes,
      baseSeed: options.baseSeed,
      gameIndexOffset: options.gameIndexOffset,
      searchWorkers: options.searchWorkers,
      searchBudgetMs: options.searchBudgetMs,
      responseReserveMs: options.responseReserveMs,
      roster: ["Nicanelo", ...options.opponents.map((item) => item.name)],
      subjectModelVersion: options.subjectModelVersion,
      provenance: options.provenance,
      searchTargetVersion: PUCT_POLICY_TARGET_VERSION,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    join(options.outputDirectory, "provenance.json"),
    `${JSON.stringify(options.provenance, null, 2)}\n`,
    { flag: "wx" },
  );

  const servers = plans.map((plan) => startServer(plan, options));
  const zooServer = startZooServer(options);
  let failure: unknown;
  try {
    if (zooServer.child.exitCode !== null) {
      throw new Error(`Zoo server exited early: ${zooServer.stderr()}`);
    }
    await Promise.all([
      ...servers.map(waitForServer),
      ...options.opponents.map(waitForOpponent),
    ]);
    console.log(JSON.stringify({
      event: "azure_job_ready",
      runId: options.runId,
      games: options.games,
      lanes: options.lanes,
      snakeProcesses: servers.length,
      zooOpponents: options.opponents.map((item) => item.name),
      searchWorkersPerSnake: options.searchWorkers,
      concurrentGymGames: plans.length,
    }));
    const laneResults = await Promise.allSettled(
      plans.map((plan) => runBatch(laneBatchOptions(plan, options))),
    );
    const laneFailures = laneResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (laneFailures.length > 0) {
      throw new AggregateError(
        laneFailures,
        `${laneFailures.length} of ${plans.length} tournament lanes failed`,
      );
    }
    await Promise.all([
      ...servers.map(stopProcess),
      stopProcess(zooServer),
    ]);
    const searchTargets = await materializeSearchTargets(plans, servers, options);
    const summary = await summarizeRun(plans, options, searchTargets);
    await writeFile(
      join(options.outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify({ event: "azure_job_summary", ...summary }));
  } catch (error) {
    failure = error;
    await writeFile(
      join(options.outputDirectory, "failure.json"),
      `${JSON.stringify({
        runId: options.runId,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown job failure",
      }, null, 2)}\n`,
    );
  } finally {
    await Promise.allSettled([
      ...servers.map(stopProcess),
      stopProcess(zooServer),
    ]);
    try {
      await uploadOutput(options);
    } catch (uploadError) {
      failure ??= uploadError;
    }
  }

  if (failure !== undefined) throw failure;
  console.log(JSON.stringify({
    event: "azure_job_complete",
    runId: options.runId,
    storagePrefix: options.uploadEnabled ? options.storagePrefix : null,
  }));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    await runAzureJob();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
