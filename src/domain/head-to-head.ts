import type {
  Battlesnake,
  Coordinate,
  Direction,
  GameState,
} from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  guaranteedOccupiedCells,
  isInsideBoard,
  moveCoordinate,
  sameCoordinate,
} from "./board.js";

export type ImmediateHeadToHeadOutcome = "none" | "winning" | "losing";

function containsCoordinate(
  coordinates: readonly Readonly<Coordinate>[],
  target: Readonly<Coordinate>,
): boolean {
  return coordinates.some((coordinate) => sameCoordinate(coordinate, target));
}

function survivesMoveTo(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
  destination: Readonly<Coordinate>,
): boolean {
  if (containsCoordinate(state.board.food, destination)) return true;
  const hazardDamage = containsCoordinate(state.board.hazards, destination)
    ? state.game.ruleset.settings.hazardDamagePerTurn
    : 0;
  return snake.health - 1 - hazardDamage > 0;
}

function canContestDestination(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
  destination: Readonly<Coordinate>,
  occupied: ReadonlySet<string>,
): boolean {
  if (
    !isInsideBoard(destination, state.board.width, state.board.height) ||
    occupied.has(coordinateKey(destination)) ||
    !survivesMoveTo(state, snake, destination)
  ) {
    return false;
  }
  return DIRECTIONS.some((direction) =>
    sameCoordinate(moveCoordinate(snake.head, direction), destination)
  );
}

/**
 * Classifies the simultaneous head collision available after one root move.
 * Food is resolved before collisions in Standard, so every snake reaching the
 * contested food receives the same one-segment growth before lengths compare.
 * Equality remains losing because equal longest heads eliminate each other.
 */
export function immediateHeadToHeadOutcome(
  state: Readonly<GameState>,
  move: Direction,
): ImmediateHeadToHeadOutcome {
  const destination = moveCoordinate(state.you.head, move);
  const occupied = guaranteedOccupiedCells(state as GameState);
  const eats = containsCoordinate(state.board.food, destination);
  const projectedLength = state.you.body.length + Number(eats);
  const contenders = state.board.snakes.filter((snake) =>
    snake.id !== state.you.id &&
    canContestDestination(state, snake, destination, occupied)
  );
  if (contenders.length === 0) return "none";

  const longestProjectedOpponent = Math.max(
    ...contenders.map((snake) => snake.body.length + Number(eats)),
  );
  return projectedLength > longestProjectedOpponent ? "winning" : "losing";
}
