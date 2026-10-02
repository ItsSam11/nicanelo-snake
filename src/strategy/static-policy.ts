import type {
  Direction,
  GameState,
  MoveResponse,
} from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  dangerousHeadToHeadCells,
  guaranteedOccupiedCells,
  isInsideBoard,
  moveCoordinate,
} from "../domain/board.js";
import { evaluateMove } from "../evaluation/evaluate-state.js";
import { healthAfterMove } from "../evaluation/spatial-analysis.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "../evaluation/weights.js";

export interface ScoredMove {
  direction: Direction;
  score: number;
}

export const DIRECTION_PRIORITY: Readonly<Record<Direction, number>> = {
  up: 4,
  right: 3,
  down: 2,
  left: 1,
};

/**
 * Directions that avoid every death detectable before simultaneous moves are
 * resolved. Unique tails are open under Standard's move-before-feed ordering;
 * duplicated tails stay blocked because one copy remains after movement.
 */
export function immediatelySafeMoves(state: GameState): Direction[] {
  const occupied = guaranteedOccupiedCells(state);
  const headThreats = dangerousHeadToHeadCells(state);

  return DIRECTIONS.filter((direction) => {
    const destination = moveCoordinate(state.you.head, direction);
    const destinationKey = coordinateKey(destination);
    return (
      isInsideBoard(destination, state.board.width, state.board.height) &&
      !occupied.has(destinationKey) &&
      !headThreats.has(destinationKey) &&
      healthAfterMove(state, destination) > 0
    );
  });
}

/**
 * Relaxes only possible head-to-head danger. This gives search a complete set
 * of physically viable actions when every conservative move is contested.
 */
export function physicallyViableMoves(state: GameState): Direction[] {
  const occupied = guaranteedOccupiedCells(state);

  return DIRECTIONS.filter((direction) => {
    const destination = moveCoordinate(state.you.head, direction);
    return (
      isInsideBoard(destination, state.board.width, state.board.height) &&
      !occupied.has(coordinateKey(destination)) &&
      healthAfterMove(state, destination) > 0
    );
  });
}

export function rankStaticMoves(
  state: GameState,
  weights: Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
): ScoredMove[] {
  const safe = immediatelySafeMoves(state);
  const candidates = safe.length > 0 ? safe : physicallyViableMoves(state);
  const evaluated = candidates.map((direction) => ({
    direction,
    evaluation: evaluateMove(state, direction, weights),
  }));
  const resourcePreserving = evaluated.filter(({ evaluation }) =>
    evaluation.tacticalIntent.resourceRequired &&
    evaluation.tacticalIntent.resourceGate
  );
  // Fallback protection must obey the same food emergency as the search
  // prior. Otherwise a deadline or conservative override can undo the route
  // that the tactical planner deliberately preserved.
  const eligible = resourcePreserving.length > 0
    ? resourcePreserving
    : evaluated;

  return eligible
    .map(({ direction, evaluation }) => ({
      direction,
      score: evaluation.total,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        DIRECTION_PRIORITY[b.direction] - DIRECTION_PRIORITY[a.direction],
    );
}

/** Deadline-safe policy used when search cannot return a completed result. */
export function chooseStaticMove(
  state: GameState,
  weights: Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
): MoveResponse {
  const best = rankStaticMoves(state, weights)[0];
  if (best !== undefined) {
    return { move: best.direction };
  }

  const lastResort = DIRECTIONS.find((direction) =>
    isInsideBoard(
      moveCoordinate(state.you.head, direction),
      state.board.width,
      state.board.height,
    ),
  );
  return { move: lastResort ?? "up" };
}
