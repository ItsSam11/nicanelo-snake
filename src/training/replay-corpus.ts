import type { Direction, Game, GameState } from "../api/types.js";
import { canonicalStateKey } from "../search/state-key.js";
import {
  analyzeBehavior,
  BEHAVIOR_PROFILE_NAMES,
  BEHAVIOR_PROFILE_VERSION,
  behaviorHistoryKey,
  type SnakeBehaviorProfile,
} from "./behavior-profile.js";
import {
  BEHAVIOR_DIMENSIONS,
  inferObservedDirection,
  type BehaviorHistorySnapshot,
} from "../model/behavior-features.js";
import {
  analyzeStrategicAggression,
  validStrategicAggressionSummaries,
  type StrategicAggressionSummary,
} from "./strategic-aggression.js";

export const GAME_SUMMARY_SCHEMA_VERSION = 2 as const;
export const MINIMUM_INITIAL_SNAKE_COUNT = 2;
export const MAXIMUM_INITIAL_SNAKE_COUNT = 4;
export type GameArtifactSource = "live" | "gym";

export interface ReplayBuildOptions {
  source?: GameArtifactSource;
  runId?: string;
  seed?: number;
  modelVersions?: readonly string[];
}

export interface OfficialReplayResult {
  winnerId: string;
  winnerName: string;
  isDraw: boolean;
}

export interface OfficialReplay {
  metadata: Game;
  states: readonly GameState[];
  result: OfficialReplayResult;
}

export interface ObservedMove {
  gameId: string;
  turn: number;
  snakeId: string;
  snakeName: string;
  stateKey: string;
  move: Direction;
  health: number;
  length: number;
  opponentsAlive: number;
  behaviorBeforeMove: BehaviorHistorySnapshot;
}

export interface EliminationRecord {
  snakeId: string;
  snakeName: string;
  lastSeenTurn: number;
  eliminatedOnTurn?: number;
  eliminationTurnConfidence?: "exact" | "inferred-next-turn" | "unknown";
  winner: boolean;
}

export interface LatencySummary {
  snakeId: string;
  snakeName: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface ReplaySummary {
  schemaVersion: typeof GAME_SUMMARY_SCHEMA_VERSION;
  source: GameArtifactSource;
  runId?: string;
  seed?: number;
  gameId: string;
  ruleset: string;
  map: string;
  timeoutMs: number;
  width: number;
  height: number;
  initialSnakeCount: number;
  finalTurn: number;
  winnerId: string;
  winnerName: string;
  isDraw: boolean;
  observedMoveCount: number;
  modelVersions: readonly string[];
  coverage: {
    kind: "full" | "controlled-snake";
    firstTurn: number;
    lastTurn: number;
    missingTurnCount: number;
  };
  eliminations: readonly EliminationRecord[];
  latency: readonly LatencySummary[];
  profiles: readonly SnakeBehaviorProfile[];
  /** Additive v2 extension; historical summaries legitimately omit it. */
  strategicAggression?: readonly StrategicAggressionSummary[];
}

export interface ReplayCorpus {
  summary: ReplaySummary;
  observations: readonly ObservedMove[];
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function validBehaviorProfiles(value: unknown): value is SnakeBehaviorProfile[] {
  if (!Array.isArray(value)) return false;
  const profileNames = new Set<string>(BEHAVIOR_PROFILE_NAMES);
  return value.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const profile = item as Partial<SnakeBehaviorProfile>;
    const scores = profile.scores;
    const opportunities = profile.opportunities;
    const confidence = profile.confidence;
    return profile.profileVersion === BEHAVIOR_PROFILE_VERSION &&
      typeof profile.snakeId === "string" && profile.snakeId.length > 0 &&
      typeof profile.snakeName === "string" &&
      typeof profile.dominantProfile === "string" &&
      profileNames.has(profile.dominantProfile) &&
      typeof scores === "object" && scores !== null &&
      typeof opportunities === "object" && opportunities !== null &&
      typeof confidence === "object" && confidence !== null &&
      BEHAVIOR_DIMENSIONS.every((dimension) =>
        typeof scores[dimension] === "number" &&
        Number.isFinite(scores[dimension]) &&
        scores[dimension] >= 0 && scores[dimension] <= 1 &&
        Number.isSafeInteger(opportunities[dimension]) &&
        opportunities[dimension] >= 0 &&
        typeof confidence[dimension] === "number" &&
        Number.isFinite(confidence[dimension]) &&
        confidence[dimension] >= 0 && confidence[dimension] <= 1
      ) &&
      typeof confidence.overall === "number" &&
      Number.isFinite(confidence.overall) &&
      confidence.overall >= 0 && confidence.overall <= 1 &&
      typeof profile.metrics === "object" && profile.metrics !== null;
  });
}

export function parseReplaySummary(text: string): ReplaySummary {
  const value = record(JSON.parse(text) as unknown, "game summary") as
    Partial<ReplaySummary>;
  const coverage = value.coverage;
  if (
    value.schemaVersion !== GAME_SUMMARY_SCHEMA_VERSION ||
    (value.source !== "live" && value.source !== "gym") ||
    typeof value.gameId !== "string" || value.gameId.length === 0 ||
    typeof value.ruleset !== "string" || typeof value.map !== "string" ||
    ![value.timeoutMs, value.width, value.height, value.initialSnakeCount,
      value.finalTurn, value.observedMoveCount].every((item) =>
        typeof item === "number" && Number.isFinite(item)
      ) ||
    typeof value.winnerId !== "string" ||
    typeof value.winnerName !== "string" ||
    typeof value.isDraw !== "boolean" ||
    !Array.isArray(value.modelVersions) ||
    !value.modelVersions.every((item) => typeof item === "string") ||
    typeof coverage !== "object" || coverage === null ||
    (coverage.kind !== "full" && coverage.kind !== "controlled-snake") ||
    ![coverage.firstTurn, coverage.lastTurn, coverage.missingTurnCount].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    ) ||
    !validBehaviorProfiles(value.profiles) ||
    (value.strategicAggression !== undefined &&
      !validStrategicAggressionSummaries(value.strategicAggression))
  ) {
    throw new Error("Invalid game summary");
  }
  return value as ReplaySummary;
}

function parseMetadata(value: unknown): Game {
  const candidate = record(value, "replay metadata");
  const ruleset = record(candidate.ruleset, "replay ruleset");
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.map !== "string" ||
    typeof candidate.timeout !== "number" ||
    typeof ruleset.name !== "string"
  ) {
    throw new Error("Replay metadata is missing required game fields");
  }
  return candidate as unknown as Game;
}

function parseState(value: unknown): GameState {
  const candidate = record(value, "replay state");
  const board = record(candidate.board, "replay board");
  if (
    typeof candidate.turn !== "number" ||
    !Array.isArray(board.snakes) ||
    typeof board.width !== "number" ||
    typeof board.height !== "number" ||
    typeof candidate.you !== "object" ||
    candidate.you === null
  ) {
    throw new Error("Replay state is missing required Battlesnake fields");
  }
  return candidate as unknown as GameState;
}

function parseResult(value: unknown): OfficialReplayResult {
  const candidate = record(value, "replay result");
  if (
    typeof candidate.winnerId !== "string" ||
    typeof candidate.winnerName !== "string" ||
    typeof candidate.isDraw !== "boolean"
  ) {
    throw new Error("Replay result is missing required winner fields");
  }
  return candidate as unknown as OfficialReplayResult;
}

/** Parses the JSONL emitted by `battlesnake play --output`. */
export function parseOfficialReplayJsonl(text: string): OfficialReplay {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 3) {
    throw new Error("A replay needs metadata, at least one state, and a result");
  }

  const values = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Replay line ${index + 1} is not valid JSON`);
    }
  });
  const metadata = parseMetadata(values[0]);
  const result = parseResult(values.at(-1));
  const states = values.slice(1, -1).map(parseState);

  if (states.some((state) => state.game.id !== metadata.id)) {
    throw new Error("Replay contains states from a different game");
  }
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1];
    const current = states[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.turn <= previous.turn
    ) {
      throw new Error("Replay turns must be strictly increasing");
    }
  }

  return { metadata, states, result };
}

export function supportedInitialSnakeCount(count: number): boolean {
  return Number.isSafeInteger(count) &&
    count >= MINIMUM_INITIAL_SNAKE_COUNT &&
    count <= MAXIMUM_INITIAL_SNAKE_COUNT;
}

/** Enforces the supported Elaniin tournament formats before admitting a replay. */
export function validateChampionshipReplay(replay: OfficialReplay): void {
  const initial = replay.states[0];
  if (initial === undefined) {
    throw new Error("Replay has no board states");
  }
  if (replay.metadata.ruleset.name !== "standard") {
    throw new Error("Championship corpus requires the standard ruleset");
  }
  if (initial.board.width !== 11 || initial.board.height !== 11) {
    throw new Error("Championship corpus requires an 11x11 board");
  }
  if (!supportedInitialSnakeCount(initial.board.snakes.length)) {
    throw new Error(
      "Championship corpus requires between two and four initial snakes",
    );
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

function latencySummaries(states: readonly GameState[]): LatencySummary[] {
  const values = new Map<string, { name: string; samples: number[] }>();
  for (const state of states) {
    for (const snake of state.board.snakes) {
      const latency = Number(snake.latency);
      if (!Number.isFinite(latency) || latency <= 0) continue;
      const current = values.get(snake.id) ?? {
        name: snake.name,
        samples: [],
      };
      current.samples.push(latency);
      values.set(snake.id, current);
    }
  }

  return [...values.entries()]
    .map(([snakeId, value]) => ({
      snakeId,
      snakeName: value.name,
      samples: value.samples.length,
      p50Ms: percentile(value.samples, 0.5),
      p95Ms: percentile(value.samples, 0.95),
      maxMs: Math.max(...value.samples),
    }))
    .sort((a, b) => a.snakeId.localeCompare(b.snakeId));
}

function eliminationRecords(
  replay: OfficialReplay,
  source: GameArtifactSource,
): EliminationRecord[] {
  const initial = replay.states[0];
  if (initial === undefined) return [];

  return initial.board.snakes.map((snake) => {
    let lastSeenTurn = initial.turn;
    let eliminatedOnTurn: number | undefined;
    let eliminationTurnConfidence:
      | "exact"
      | "inferred-next-turn"
      | "unknown"
      | undefined;
    for (let index = 1; index < replay.states.length; index += 1) {
      const state = replay.states[index];
      if (state === undefined) continue;
      if (state.board.snakes.some((item) => item.id === snake.id)) {
        lastSeenTurn = state.turn;
      } else {
        if (state.turn === lastSeenTurn + 1) {
          eliminatedOnTurn = state.turn;
          eliminationTurnConfidence = "exact";
        } else if (source === "live" && snake.id === initial.you.id) {
          eliminatedOnTurn = lastSeenTurn + 1;
          eliminationTurnConfidence = "inferred-next-turn";
        } else {
          eliminationTurnConfidence = "unknown";
        }
        break;
      }
    }
    return {
      snakeId: snake.id,
      snakeName: snake.name,
      lastSeenTurn,
      ...(eliminatedOnTurn === undefined ? {} : { eliminatedOnTurn }),
      ...(eliminationTurnConfidence === undefined
        ? {}
        : { eliminationTurnConfidence }),
      winner: replay.result.winnerId === snake.id,
    };
  });
}

/** Produces supervised move labels and game-level outcome/latency metadata. */
export function buildReplayCorpus(
  replay: OfficialReplay,
  options: Readonly<ReplayBuildOptions> = {},
): ReplayCorpus {
  const initial = replay.states[0];
  const final = replay.states.at(-1);
  if (initial === undefined || final === undefined) {
    throw new Error("Replay has no board states");
  }

  const rawObservations: Omit<ObservedMove, "behaviorBeforeMove">[] = [];
  for (let index = 0; index + 1 < replay.states.length; index += 1) {
    const before = replay.states[index];
    const after = replay.states[index + 1];
    if (before === undefined || after === undefined) continue;
    // Production telemetry can stop while our snake is eliminated and resume
    // at /end. Never infer moves across missing turns.
    if (after.turn !== before.turn + 1) continue;

    for (const snake of before.board.snakes) {
      const surviving = after.board.snakes.find((item) => item.id === snake.id);
      if (surviving === undefined) {
        // The official replay removes eliminated snakes, so their final move is
        // not observable from consecutive board snapshots.
        continue;
      }
      const move = inferObservedDirection(snake, surviving);
      if (move === undefined) {
        throw new Error(
          `Cannot infer move for snake ${snake.id} from turn ${before.turn}`,
        );
      }
      const perspective = { ...before, you: snake };
      rawObservations.push({
        gameId: replay.metadata.id,
        turn: before.turn,
        snakeId: snake.id,
        snakeName: snake.name,
        stateKey: canonicalStateKey(perspective),
        move,
        health: snake.health,
        length: snake.length,
        opponentsAlive: before.board.snakes.length - 1,
      });
    }
  }

  const missingTurnCount = replay.states.slice(1).reduce((total, state, index) => {
    const previous = replay.states[index];
    return total + Math.max(0, state.turn - (previous?.turn ?? state.turn) - 1);
  }, 0);
  const behavior = analyzeBehavior(replay, rawObservations);
  const observations: ObservedMove[] = rawObservations.map((observation) => {
    const history = behavior.historyBeforeMove.get(
      behaviorHistoryKey(observation.turn, observation.snakeId),
    );
    if (history === undefined) {
      throw new Error(
        `Missing behavior history for ${observation.snakeId} on turn ${observation.turn}`,
      );
    }
    return { ...observation, behaviorBeforeMove: history };
  });
  return {
    summary: {
      schemaVersion: GAME_SUMMARY_SCHEMA_VERSION,
      source: options.source ?? "gym",
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      gameId: replay.metadata.id,
      ruleset: replay.metadata.ruleset.name,
      map: replay.metadata.map,
      timeoutMs: replay.metadata.timeout,
      width: initial.board.width,
      height: initial.board.height,
      initialSnakeCount: initial.board.snakes.length,
      finalTurn: final.turn,
      winnerId: replay.result.winnerId,
      winnerName: replay.result.winnerName,
      isDraw: replay.result.isDraw,
      observedMoveCount: observations.length,
      modelVersions: [...new Set(options.modelVersions ?? [])].sort(),
      coverage: {
        kind: missingTurnCount === 0 ? "full" : "controlled-snake",
        firstTurn: initial.turn,
        lastTurn: final.turn,
        missingTurnCount,
      },
      eliminations: eliminationRecords(replay, options.source ?? "gym"),
      latency: latencySummaries(replay.states),
      profiles: behavior.profiles,
      strategicAggression: analyzeStrategicAggression(replay, observations),
    },
    observations,
  };
}

export function serializeOfficialReplay(replay: Readonly<OfficialReplay>): string {
  return [
    replay.metadata,
    ...replay.states,
    replay.result,
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
}
