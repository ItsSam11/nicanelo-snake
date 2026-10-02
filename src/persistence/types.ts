import type { GameState } from "../api/types.js";
import type { RootMoveStatistics } from "../search/mcts.js";
import type { RootSafetyDecision } from "../search/root-safety-arbiter.js";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export interface ObservedOpponentMove {
  snakeId: string;
  snakeName: string;
  move: "up" | "down" | "left" | "right";
}

export interface MoveSearchTelemetry {
  iterations: number;
  elapsedMs: number;
  deadlineReached: boolean;
  usedSearch: boolean;
  fallbackProtected: boolean;
  priorVisits: number;
  reusedTree: boolean;
  cacheHits: number;
  cacheMisses: number;
  workersRequested: number;
  workersCompleted: number;
  rootStatistics: readonly RootMoveStatistics[];
  rootSafety?: RootSafetyDecision;
}

export interface MoveTelemetryRecord {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  event: "move";
  recordedAt: string;
  modelVersion: string;
  gameId: string;
  turn: number;
  ruleset: string;
  map: string;
  stateKey: string;
  state: GameState;
  fallbackMove: "up" | "down" | "left" | "right";
  finalMove: "up" | "down" | "left" | "right";
  requestElapsedMs: number;
  observedOpponentMoves: readonly ObservedOpponentMove[];
  search: MoveSearchTelemetry;
}

export interface GameLifecycleTelemetryRecord {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  event: "game_start" | "game_end";
  recordedAt: string;
  modelVersion: string;
  gameId: string;
  turn: number;
  ruleset: string;
  map: string;
  state: GameState;
}

export type PersistenceRecord =
  | MoveTelemetryRecord
  | GameLifecycleTelemetryRecord;

export interface HotGameSummary {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  gameId: string;
  turn: number;
  stateKey: string;
  fallbackMove: "up" | "down" | "left" | "right";
  finalMove: "up" | "down" | "left" | "right";
  modelVersion: string;
  updatedAt: string;
  rootStatistics: readonly RootMoveStatistics[];
  rootSafety?: RootSafetyDecision;
  observedOpponentMoves: readonly ObservedOpponentMove[];
}

export interface TelemetrySink {
  write(record: Readonly<PersistenceRecord>): Promise<void>;
  close(): Promise<void>;
}

export interface HotStateStore {
  write(summary: Readonly<HotGameSummary>): Promise<void>;
  close(): Promise<void>;
}
