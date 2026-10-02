import type { Battlesnake, GameState } from "../api/types.js";
import { guaranteedOccupiedCells } from "../domain/board.js";
import type { BehaviorHistorySnapshot } from "../model/behavior-features.js";
import {
  immediatelySafeMoves,
  physicallyViableMoves,
} from "./static-policy.js";

export type StrategicPhase = "multiplayer" | "three-player" | "duel";

export interface StrategicPosture {
  phase: StrategicPhase;
  safetyReserve: number;
  resourceUrgency: number;
  initiative: number;
  context: BehaviorHistorySnapshot;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function perspectiveState(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
): GameState {
  return { ...state, you: snake as Battlesnake };
}

function phaseFor(opponentCount: number): StrategicPhase {
  if (opponentCount <= 1) return "duel";
  if (opponentCount === 2) return "three-player";
  return "multiplayer";
}

function escapeReserve(moveCount: number): number {
  if (moveCount <= 0) return 0;
  // One real exit is fragile, but it is not equivalent to being trapped. The
  // floor keeps a moderate initiative signal alive while two and three exits
  // progressively restore normal freedom of action.
  return 0.25 + 0.75 * clamp((moveCount - 1) / 2);
}

/**
 * Produces a continuously varying desired posture for our policy prior.
 * This is deliberately not a persistent personality: every simulated state
 * can move between initiative, acquisition, and recovery as its reserves
 * change.
 */
export function strategicPosture(
  state: Readonly<GameState>,
  snakeId = state.you.id,
): StrategicPosture {
  const snake = state.board.snakes.find((item) => item.id === snakeId);
  if (snake === undefined) {
    throw new Error(`Cannot build strategic posture for missing snake ${snakeId}`);
  }
  const perspective = perspectiveState(state, snake);
  const opponents = state.board.snakes.filter((item) => item.id !== snakeId);
  const phase = phaseFor(opponents.length);
  const safeMoves = immediatelySafeMoves(perspective).length;
  const viableMoves = physicallyViableMoves(perspective).length;
  const mobilityReserve = escapeReserve(safeMoves);
  const physicalReserve = escapeReserve(viableMoves);
  const healthReserve = clamp((snake.health - 20) / 60);
  const boardArea = Math.max(state.board.width * state.board.height, 1);
  const occupancy = guaranteedOccupiedCells(perspective).size / boardArea;
  const openBoardReserve = clamp(1 - occupancy / 0.7);
  const safetyReserve = safeMoves === 0
    ? 0
    : clamp(
      (0.75 * mobilityReserve + 0.25 * physicalReserve) *
        (0.55 + 0.45 * healthReserve) *
        (0.75 + 0.25 * openBoardReserve),
    );

  const maximumOpponentLength = opponents.reduce(
    (maximum, opponent) => Math.max(maximum, opponent.length),
    snake.length,
  );
  const lengthDeficit = clamp(
    (maximumOpponentLength - snake.length) / 8,
  );
  const hunger = clamp((70 - snake.health) / 55);
  const resourceUrgency = clamp(
    0.3 + 0.5 * hunger + 0.3 * lengthDeficit,
  );
  const phaseInitiative = phase === "duel"
    ? 1
    : phase === "three-player"
      ? 0.85
      : 0.7;
  const lengthControl = opponents.length === 0
    ? 1
    : opponents.reduce(
      (total, opponent) => total + (
        snake.length > opponent.length
          ? 1
          : snake.length === opponent.length
            ? 0.5
            : 0
      ),
      0,
    ) / opponents.length;
  const initiative = clamp(
    safetyReserve *
      (0.55 + 0.3 * phaseInitiative + 0.15 * lengthControl),
  );

  const aggression = clamp(
    0.35 + 0.6 * initiative + (phase === "duel" ? 0.1 : 0),
  );
  const healthManagement = clamp(
    0.35 + 0.55 * hunger + 0.15 * (1 - mobilityReserve),
  );
  const conservatism = clamp(
    0.8 - 0.65 * initiative + 0.15 * (1 - healthReserve),
  );
  const confidence = safeMoves + viableMoves >= 3 ? 1 : 0.85;
  const context: BehaviorHistorySnapshot = {
    scores: {
      aggression,
      resourceAcquisition: resourceUrgency,
      healthManagement,
      conservatism,
    },
    opportunities: {
      aggression: 1,
      resourceAcquisition: 1,
      healthManagement: 1,
      conservatism: 1,
    },
    confidence: {
      aggression: confidence,
      resourceAcquisition: confidence,
      healthManagement: confidence,
      conservatism: confidence,
      overall: confidence,
    },
    decisionsObserved: 1,
    decisionDenseTurns: 1,
    decisionDensity: 1,
  };

  return {
    phase,
    safetyReserve,
    resourceUrgency,
    initiative,
    context,
  };
}
