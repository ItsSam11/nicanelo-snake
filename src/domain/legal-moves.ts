import type { Direction, GameState } from "../api/types.js";
import { DIRECTIONS } from "./board.js";

export type SnakeMoves = Readonly<Record<string, Direction>>;

const DIRECTION_SET = new Set<string>(DIRECTIONS);

export function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && DIRECTION_SET.has(value);
}

/**
 * Validates the joint action passed to the simulator. Every direction is a
 * legal Battlesnake response, even when it leads to an immediate elimination.
 * Safety is determined by the turn simulator after all moves are applied.
 */
export function validateMoves(state: GameState, moves: SnakeMoves): void {
  const snakeIds = new Set<string>();

  for (const snake of state.board.snakes) {
    if (snakeIds.has(snake.id)) {
      throw new Error(`Duplicate snake id: ${snake.id}`);
    }
    if (snake.body.length === 0) {
      throw new Error(`Snake ${snake.id} has an empty body`);
    }
    snakeIds.add(snake.id);
  }

  if (!snakeIds.has(state.you.id)) {
    throw new Error(`The controlled snake ${state.you.id} is not on the board`);
  }

  for (const snake of state.board.snakes) {
    const move: unknown = moves[snake.id];
    if (!isDirection(move)) {
      throw new Error(`Missing or invalid move for snake ${snake.id}`);
    }
  }

  for (const snakeId of Object.keys(moves)) {
    if (!snakeIds.has(snakeId)) {
      throw new Error(`Move supplied for unknown snake ${snakeId}`);
    }
  }
}
