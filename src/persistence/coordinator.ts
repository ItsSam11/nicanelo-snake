import { randomUUID } from "node:crypto";
import type { GameState } from "../api/types.js";
import { DEFAULT_STRATEGY_MODEL } from "../model/strategy-model.js";
import { inferObservedDirection } from "../model/behavior-features.js";
import type { PooledSearchResult } from "../search/search-pool.js";
import { canonicalStateKey } from "../search/state-key.js";
import {
  BestEffortQueue,
  type BestEffortQueueStatistics,
  type PersistenceLogger,
} from "./async-queue.js";
import { AzureBlobTelemetrySink } from "./azure-blob.js";
import { AzureRedisHotStateStore } from "./azure-redis.js";
import { JsonlFileTelemetrySink } from "./jsonl-file.js";
import {
  TELEMETRY_SCHEMA_VERSION,
  type GameLifecycleTelemetryRecord,
  type HotGameSummary,
  type HotStateStore,
  type MoveTelemetryRecord,
  type ObservedOpponentMove,
  type TelemetrySink,
} from "./types.js";

export interface PersistenceCoordinatorOptions {
  telemetrySink?: TelemetrySink;
  hotStateStore?: HotStateStore;
  queueCapacity?: number;
  flushTimeoutMs?: number;
  modelVersion?: string;
  now?: () => Date;
  eventId?: () => string;
  logger?: PersistenceLogger;
}

export interface MovePersistenceInput {
  state: GameState;
  diagnostics: PooledSearchResult;
  requestElapsedMs: number;
}

function defaultLogger(entry: Readonly<Record<string, unknown>>): void {
  console.error(JSON.stringify(entry));
}

function observedOpponentMoves(
  previous: GameState | undefined,
  current: GameState,
): ObservedOpponentMove[] {
  if (
    previous === undefined ||
    previous.game.id !== current.game.id ||
    current.turn !== previous.turn + 1
  ) {
    return [];
  }

  const observations: ObservedOpponentMove[] = [];
  for (const snake of previous.board.snakes) {
    if (snake.id === previous.you.id) continue;
    const after = current.board.snakes.find((item) => item.id === snake.id);
    if (after === undefined) continue;
    const move = inferObservedDirection(snake, after);
    if (move !== undefined) {
      observations.push({
        snakeId: snake.id,
        snakeName: snake.name,
        move,
      });
    }
  }
  return observations;
}

function finiteMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Coordinates optional persistence without putting I/O on the move path. */
export class PersistenceCoordinator {
  private readonly telemetrySink: TelemetrySink | undefined;
  private readonly hotStateStore: HotStateStore | undefined;
  private readonly queue: BestEffortQueue;
  private readonly flushTimeoutMs: number;
  private readonly modelVersion: string;
  private readonly now: () => Date;
  private readonly eventId: () => string;
  private readonly logger: PersistenceLogger;
  private readonly previousStates = new Map<string, GameState>();
  private closed = false;

  constructor(options: Readonly<PersistenceCoordinatorOptions> = {}) {
    this.telemetrySink = options.telemetrySink;
    this.hotStateStore = options.hotStateStore;
    this.flushTimeoutMs = options.flushTimeoutMs ?? 5_000;
    this.modelVersion =
      options.modelVersion ?? DEFAULT_STRATEGY_MODEL.modelVersion;
    this.now = options.now ?? (() => new Date());
    this.eventId = options.eventId ?? randomUUID;
    this.logger = options.logger ?? defaultLogger;
    if (!Number.isInteger(this.flushTimeoutMs) || this.flushTimeoutMs < 0) {
      throw new Error("Persistence flush timeout must be a non-negative integer");
    }
    this.queue = new BestEffortQueue({
      ...(options.queueCapacity === undefined
        ? {}
        : { capacity: options.queueCapacity }),
      concurrency: 1,
      logger: this.logger,
    });
  }

  get statistics(): BestEffortQueueStatistics {
    return this.queue.statistics;
  }

  recordStart(state: GameState): void {
    this.previousStates.set(state.game.id, state);
    this.enqueueLifecycle("game_start", state);
  }

  recordMove(input: Readonly<MovePersistenceInput>): void {
    if (this.closed) return;
    const { state, diagnostics } = input;
    const recordedAt = this.now().toISOString();
    const observations = observedOpponentMoves(
      this.previousStates.get(state.game.id),
      state,
    );
    this.previousStates.set(state.game.id, state);

    const record: MoveTelemetryRecord = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: this.eventId(),
      event: "move",
      recordedAt,
      modelVersion: this.modelVersion,
      gameId: state.game.id,
      turn: state.turn,
      ruleset: state.game.ruleset.name,
      map: state.game.map,
      stateKey: canonicalStateKey(state),
      state,
      fallbackMove: diagnostics.fallbackMove,
      finalMove: diagnostics.move,
      requestElapsedMs: finiteMilliseconds(input.requestElapsedMs),
      observedOpponentMoves: observations,
      search: {
        iterations: diagnostics.iterations,
        elapsedMs: finiteMilliseconds(diagnostics.elapsedMs),
        deadlineReached: diagnostics.deadlineReached,
        usedSearch: diagnostics.usedSearch,
        fallbackProtected: diagnostics.fallbackProtected,
        priorVisits: diagnostics.priorVisits,
        reusedTree: diagnostics.reusedTree,
        cacheHits: diagnostics.cacheHits,
        cacheMisses: diagnostics.cacheMisses,
        workersRequested: diagnostics.workersRequested,
        workersCompleted: diagnostics.workersCompleted,
        rootStatistics: diagnostics.rootStatistics,
        ...(diagnostics.rootSafety === undefined
          ? {}
          : { rootSafety: diagnostics.rootSafety }),
      },
    };
    const hotSummary: HotGameSummary = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      gameId: record.gameId,
      turn: record.turn,
      stateKey: record.stateKey,
      fallbackMove: record.fallbackMove,
      finalMove: record.finalMove,
      modelVersion: record.modelVersion,
      updatedAt: record.recordedAt,
      rootStatistics: record.search.rootStatistics,
      ...(record.search.rootSafety === undefined
        ? {}
        : { rootSafety: record.search.rootSafety }),
      observedOpponentMoves: observations,
    };

    this.queue.enqueue("move", async () => {
      const tasks: Promise<void>[] = [];
      if (this.telemetrySink !== undefined) {
        tasks.push(this.telemetrySink.write(record));
      }
      if (this.hotStateStore !== undefined) {
        tasks.push(this.hotStateStore.write(hotSummary));
      }
      const results = await Promise.allSettled(tasks);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new Error(
          failures.map((failure) =>
            failure.reason instanceof Error
              ? failure.reason.message
              : "Persistence sink failed"
          ).join("; "),
        );
      }
    });
  }

  recordEnd(state: GameState): void {
    this.previousStates.delete(state.game.id);
    this.enqueueLifecycle("game_end", state);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.previousStates.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.flushTimeoutMs);
    });
    await Promise.race([this.queue.close(), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    await Promise.allSettled([
      this.telemetrySink?.close() ?? Promise.resolve(),
      this.hotStateStore?.close() ?? Promise.resolve(),
    ]);
  }

  private enqueueLifecycle(
    event: "game_start" | "game_end",
    state: GameState,
  ): void {
    if (this.closed) return;
    const record: GameLifecycleTelemetryRecord = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: this.eventId(),
      event,
      recordedAt: this.now().toISOString(),
      modelVersion: this.modelVersion,
      gameId: state.game.id,
      turn: state.turn,
      ruleset: state.game.ruleset.name,
      map: state.game.map,
      state,
    };
    this.queue.enqueue(event, async () => {
      const tasks: Promise<void>[] = [];
      if (this.telemetrySink !== undefined) {
        tasks.push(this.telemetrySink.write(record));
      }
      const results = await Promise.allSettled(tasks);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) {
        throw failure.reason;
      }
    });
  }
}

function enabled(value: string | undefined): boolean {
  return value?.toLowerCase() === "true" || value === "1";
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Invalid optional configuration is logged and disabled, never fatal. */
export function createPersistenceCoordinatorFromEnvironment(): PersistenceCoordinator {
  const logger = defaultLogger;
  let telemetrySink: TelemetrySink | undefined;
  let hotStateStore: HotStateStore | undefined;

  if (enabled(process.env.AZURE_BLOB_ENABLED)) {
    const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
    if (accountUrl === undefined || accountUrl.length === 0) {
      logger({
        event: "persistence_config_error",
        component: "blob",
        error: "AZURE_STORAGE_ACCOUNT_URL is required",
      });
    } else {
      try {
        telemetrySink = new AzureBlobTelemetrySink({
          accountUrl,
          containerName:
            process.env.AZURE_STORAGE_CONTAINER ?? "battlesnake-corpus",
          prefix: process.env.AZURE_STORAGE_PREFIX ?? "telemetry/raw/live",
        });
      } catch (error) {
        logger({
          event: "persistence_config_error",
          component: "blob",
          error: error instanceof Error ? error.message : "Invalid Blob configuration",
        });
      }
    }
  }

  const fileTelemetryPath = process.env.FILE_TELEMETRY_PATH;
  if (fileTelemetryPath !== undefined && fileTelemetryPath.length > 0) {
    if (telemetrySink !== undefined) {
      logger({
        event: "persistence_config_error",
        component: "file",
        error: "FILE_TELEMETRY_PATH cannot be combined with Azure Blob telemetry",
      });
    } else {
      try {
        telemetrySink = new JsonlFileTelemetrySink(fileTelemetryPath);
      } catch (error) {
        logger({
          event: "persistence_config_error",
          component: "file",
          error: error instanceof Error ? error.message : "Invalid file configuration",
        });
      }
    }
  }

  if (enabled(process.env.REDIS_ENABLED)) {
    const endpoint = process.env.REDIS_ENDPOINT;
    if (endpoint === undefined || endpoint.length === 0) {
      logger({
        event: "persistence_config_error",
        component: "redis",
        error: "REDIS_ENDPOINT is required",
      });
    } else {
      try {
        hotStateStore = new AzureRedisHotStateStore({
          endpoint,
          keyPrefix: process.env.REDIS_KEY_PREFIX ?? "battlesnake",
          ttlSeconds: integerEnvironment("REDIS_TTL_SECONDS", 1_800, 1),
          connectTimeoutMs: integerEnvironment(
            "REDIS_CONNECT_TIMEOUT_MS",
            1_500,
            1,
          ),
          logger,
        });
      } catch (error) {
        logger({
          event: "persistence_config_error",
          component: "redis",
          error: error instanceof Error ? error.message : "Invalid Redis configuration",
        });
      }
    }
  }

  return new PersistenceCoordinator({
    ...(telemetrySink === undefined ? {} : { telemetrySink }),
    ...(hotStateStore === undefined ? {} : { hotStateStore }),
    queueCapacity: integerEnvironment("PERSISTENCE_QUEUE_CAPACITY", 512, 1),
    flushTimeoutMs: integerEnvironment(
      "PERSISTENCE_FLUSH_TIMEOUT_MS",
      5_000,
      0,
    ),
    modelVersion:
      process.env.MODEL_VERSION ?? DEFAULT_STRATEGY_MODEL.modelVersion,
    logger,
  });
}
