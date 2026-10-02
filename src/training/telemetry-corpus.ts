import type { GameState } from "../api/types.js";
import {
  TELEMETRY_SCHEMA_VERSION,
  type PersistenceRecord,
} from "../persistence/types.js";
import type { OfficialReplay } from "./replay-corpus.js";

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function gameState(value: unknown): GameState {
  const state = record(value, "telemetry state");
  const game = record(state.game, "telemetry game");
  const board = record(state.board, "telemetry board");
  if (
    typeof game.id !== "string" ||
    typeof state.turn !== "number" ||
    !Array.isArray(board.snakes) ||
    typeof state.you !== "object" ||
    state.you === null
  ) {
    throw new Error("Telemetry state is missing required Battlesnake fields");
  }
  return state as unknown as GameState;
}

export function parseTelemetryRecord(value: unknown): PersistenceRecord {
  const candidate = record(value, "telemetry record");
  if (candidate.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported telemetry schema ${String(candidate.schemaVersion)}`);
  }
  if (
    candidate.event !== "game_start" &&
    candidate.event !== "move" &&
    candidate.event !== "game_end"
  ) {
    throw new Error("Unsupported telemetry event");
  }
  if (
    typeof candidate.gameId !== "string" ||
    typeof candidate.turn !== "number" ||
    typeof candidate.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.recordedAt))
  ) {
    throw new Error("Telemetry record is missing identity fields");
  }
  const state = gameState(candidate.state);
  if (state.game.id !== candidate.gameId || state.turn !== candidate.turn) {
    throw new Error("Telemetry identity does not match its state");
  }
  return { ...candidate, state } as unknown as PersistenceRecord;
}

export function parseTelemetryJson(text: string): PersistenceRecord {
  try {
    return parseTelemetryRecord(JSON.parse(text) as unknown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Invalid telemetry JSON: ${detail}`);
  }
}

function boardStateKey(state: GameState): string {
  const coordinates = (values: readonly { x: number; y: number }[]) =>
    [...values].sort((a, b) => a.x - b.x || a.y - b.y);
  return JSON.stringify({
    turn: state.turn,
    food: coordinates(state.board.food),
    hazards: coordinates(state.board.hazards),
    snakes: [...state.board.snakes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((snake) => ({
        id: snake.id,
        health: snake.health,
        length: snake.length,
        body: snake.body,
      })),
  });
}

/** Reconstructs only complete games; partial uploads remain excluded. */
export function officialReplaysFromTelemetry(
  records: readonly PersistenceRecord[],
): OfficialReplay[] {
  const groups = new Map<string, PersistenceRecord[]>();
  for (const item of records) {
    const group = groups.get(item.gameId) ?? [];
    group.push(item);
    groups.set(item.gameId, group);
  }

  const replays: OfficialReplay[] = [];
  for (const [gameId, group] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const start = group
      .filter((item) => item.event === "game_start")
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))[0];
    const end = group
      .filter((item) => item.event === "game_end")
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    if (start === undefined || end === undefined) continue;
    if (end.state.board.snakes.length > 1) continue;

    const statesByTurn = new Map<number, GameState>();
    const stateKeys = new Map<number, string>();
    for (const item of group.sort((a, b) =>
      a.turn - b.turn || a.recordedAt.localeCompare(b.recordedAt)
    )) {
      const key = boardStateKey(item.state);
      const previousKey = stateKeys.get(item.turn);
      if (previousKey !== undefined && previousKey !== key) {
        throw new Error(
          `Conflicting telemetry states for game ${gameId} turn ${item.turn}`,
        );
      }
      if (!statesByTurn.has(item.turn)) {
        statesByTurn.set(item.turn, item.state);
        stateKeys.set(item.turn, key);
      }
    }
    const states = [...statesByTurn.values()].sort((a, b) => a.turn - b.turn);
    if (states.length < 2) continue;
    const winner = end.state.board.snakes[0];
    replays.push({
      metadata: start.state.game,
      states,
      result: {
        winnerId: winner?.id ?? "",
        winnerName: winner?.name ?? "",
        isDraw: winner === undefined,
      },
    });
  }
  return replays;
}
