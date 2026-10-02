import type {
  Battlesnake,
  Direction,
  GameState,
} from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  countOpenNeighbours,
  dangerousHeadToHeadCells,
  guaranteedOccupiedCells,
  manhattanDistance,
  moveCoordinate,
  sameCoordinate,
} from "../domain/board.js";
import { healthAfterMove } from "../evaluation/spatial-analysis.js";
import {
  foodMotivation,
  normalizedFoodAccess,
  type FoodMotivationContext,
} from "../evaluation/food-strategy.js";
import {
  BEHAVIOR_DIMENSIONS,
  behaviorCandidates,
  type BehaviorCandidate,
  type BehaviorHistorySnapshot,
} from "../model/behavior-features.js";
import { strategicPosture } from "../strategy/strategic-posture.js";
import { physicallyViableMoves } from "../strategy/static-policy.js";

export interface OpponentPolicyWeights {
  mobility: number;
  foodAccess: number;
  headSafety: number;
  hazardSafety: number;
  wallDistance: number;
  contextualAggression: number;
  contextualResourceAcquisition: number;
  contextualHealthManagement: number;
  contextualConservatism: number;
}

export interface OpponentPolicySettings {
  temperature: number;
  weights: Readonly<OpponentPolicyWeights>;
}

export interface OpponentMoveFeatures {
  mobility: number;
  foodAccess: number;
  headSafety: number;
  hazardSafety: number;
  wallDistance: number;
  contextualAggression: number;
  contextualResourceAcquisition: number;
  contextualHealthManagement: number;
  contextualConservatism: number;
}

export interface OpponentMoveProbability {
  move: Direction;
  probability: number;
  score: number;
  features: Readonly<OpponentMoveFeatures>;
}

export type RandomSource = () => number;

export const DEFAULT_OPPONENT_POLICY: Readonly<OpponentPolicySettings> =
  Object.freeze({
    temperature: 1.15,
    weights: Object.freeze({
      mobility: 2.2,
      foodAccess: 2.5,
      headSafety: 3.5,
      hazardSafety: 1.5,
      wallDistance: 0.5,
      contextualAggression: 0,
      contextualResourceAcquisition: 0,
      contextualHealthManagement: 0,
      contextualConservatism: 0,
    }),
  });

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function validateFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

export function resolveOpponentPolicy(
  overrides: {
    temperature?: number;
    weights?: Partial<OpponentPolicyWeights>;
  } = {},
): OpponentPolicySettings {
  const temperature =
    overrides.temperature ?? DEFAULT_OPPONENT_POLICY.temperature;
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error("Opponent policy temperature must be positive and finite");
  }

  const weights = {
    ...DEFAULT_OPPONENT_POLICY.weights,
    ...overrides.weights,
  };
  for (const [name, value] of Object.entries(weights)) {
    validateFinite(`Opponent policy weight ${name}`, value);
  }

  return { temperature, weights };
}

function perspectiveState(
  state: GameState,
  snake: Battlesnake,
): GameState {
  return { ...state, you: snake };
}

type FoodSpaceEstimate = Required<Pick<
  FoodMotivationContext,
  "reachableCells" | "enclosureRisk" | "boardArea" | "occupiedCells"
>>;

/** Cheap global-space approximation for the rollout opponent model. */
function foodSpaceEstimate(
  state: GameState,
  snake: Battlesnake,
): FoodSpaceEstimate {
  const perspective = perspectiveState(state, snake);
  const occupied = guaranteedOccupiedCells(perspective);
  const boardArea = Math.max(state.board.width * state.board.height, 1);
  const reachableCells = Math.max(1, boardArea - occupied.size + 1);
  const openExits = countOpenNeighbours(snake.head, perspective, occupied);
  const relativeSpace = reachableCells / Math.max(snake.length + 1, 1);
  const enclosureRisk = reachableCells < snake.length + 1
    ? "critical"
    : openExits <= 1
      ? "high"
      : relativeSpace < 2
        ? "moderate"
        : "low";
  return {
    reachableCells,
    enclosureRisk,
    boardArea,
    occupiedCells: occupied.size,
  };
}

function foodAccess(
  state: GameState,
  snake: Battlesnake,
  destination: { x: number; y: number },
  space: Readonly<FoodSpaceEstimate>,
): number {
  if (state.board.food.length === 0) {
    return 0;
  }
  const opponents = state.board.snakes.filter((item) => item.id !== snake.id);
  const destinationHasFood = state.board.food.some((food) =>
    sameCoordinate(food, destination)
  );
  const distance = destinationHasFood
    ? 0
    : Math.min(
      ...state.board.food.map((food) => manhattanDistance(destination, food)),
    );
  const motivation = foodMotivation(snake, opponents, {
    foodDistance: distance,
    reachableCells: space.reachableCells,
    enclosureRisk: space.enclosureRisk,
    origin: destination,
    boardArea: space.boardArea,
    occupiedCells: space.occupiedCells,
  });
  if (destinationHasFood) {
    return motivation;
  }

  return normalizedFoodAccess(
    motivation,
    distance,
    true,
    state.board.width,
    state.board.height,
  );
}

function wallDistance(
  state: GameState,
  destination: { x: number; y: number },
): number {
  const distance = Math.min(
    destination.x,
    destination.y,
    state.board.width - 1 - destination.x,
    state.board.height - 1 - destination.y,
  );
  return clamp(
    distance / Math.max(Math.floor(Math.min(state.board.width, state.board.height) / 2), 1),
  );
}

function moveFeatures(
  state: GameState,
  snake: Battlesnake,
  move: Direction,
  behavior: readonly BehaviorCandidate[],
  context: Readonly<BehaviorHistorySnapshot> | undefined,
  space: Readonly<FoodSpaceEstimate>,
): OpponentMoveFeatures {
  const perspective = perspectiveState(state, snake);
  const destination = moveCoordinate(snake.head, move);
  const occupied = guaranteedOccupiedCells(perspective);
  const threats = dangerousHeadToHeadCells(perspective);
  const hazardKeys = new Set(state.board.hazards.map(coordinateKey));

  const interactions = behaviorInteractions(behavior, move, context);
  return {
    mobility: clamp(
      countOpenNeighbours(destination, perspective, occupied) / DIRECTIONS.length,
    ),
    foodAccess: foodAccess(state, snake, destination, space),
    headSafety: threats.has(coordinateKey(destination)) ? 0 : 1,
    hazardSafety: hazardKeys.has(coordinateKey(destination)) ? 0 : 1,
    wallDistance: wallDistance(state, destination),
    ...interactions,
  };
}

function behaviorInteractions(
  candidates: readonly BehaviorCandidate[],
  move: Direction,
  context: Readonly<BehaviorHistorySnapshot> | undefined,
): Pick<
  OpponentMoveFeatures,
  | "contextualAggression"
  | "contextualResourceAcquisition"
  | "contextualHealthManagement"
  | "contextualConservatism"
> {
  const chosen = candidates.find((candidate) => candidate.move === move);
  const interaction = (dimension: typeof BEHAVIOR_DIMENSIONS[number]): number => {
    if (context === undefined || chosen === undefined) return 0;
    const values = candidates.map((candidate) => candidate.utilities[dimension]);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const spread = maximum - minimum;
    if (!(spread > 1e-9)) return 0;
    const behaviorPreference = 2 * (context.scores[dimension] - 0.5);
    const actionExpression = 2 *
      ((chosen.utilities[dimension] - minimum) / spread - 0.5);
    return behaviorPreference * actionExpression * context.confidence[dimension];
  };
  return {
    contextualAggression: interaction("aggression"),
    contextualResourceAcquisition: interaction("resourceAcquisition"),
    contextualHealthManagement: interaction("healthManagement"),
    contextualConservatism: interaction("conservatism"),
  };
}

function weightedScore(
  features: Readonly<OpponentMoveFeatures>,
  weights: Readonly<OpponentPolicyWeights>,
): number {
  return (
    features.mobility * weights.mobility +
    features.foodAccess * weights.foodAccess +
    features.headSafety * weights.headSafety +
    features.hazardSafety * weights.hazardSafety +
    features.wallDistance * weights.wallDistance
    + features.contextualAggression * weights.contextualAggression
    + features.contextualResourceAcquisition *
      weights.contextualResourceAcquisition
    + features.contextualHealthManagement * weights.contextualHealthManagement
    + features.contextualConservatism * weights.contextualConservatism
  );
}

function fallbackCandidates(state: GameState, snake: Battlesnake): Direction[] {
  const perspective = perspectiveState(state, snake);
  const viable = physicallyViableMoves(perspective);
  if (viable.length > 0) {
    return viable;
  }

  return [...DIRECTIONS].sort((a, b) => {
    const aHealth = healthAfterMove(
      perspective,
      moveCoordinate(snake.head, a),
    );
    const bHealth = healthAfterMove(
      perspective,
      moveCoordinate(snake.head, b),
    );
    return bHealth - aHealth;
  });
}

/** Returns a normalized categorical distribution for one living opponent. */
export function opponentMoveDistribution(
  state: GameState,
  snakeId: string,
  settings: Readonly<OpponentPolicySettings> = DEFAULT_OPPONENT_POLICY,
  context?: Readonly<BehaviorHistorySnapshot>,
): OpponentMoveProbability[] {
  const snake = state.board.snakes.find((item) => item.id === snakeId);
  if (snake === undefined) {
    throw new Error(`Cannot model missing opponent ${snakeId}`);
  }
  if (!Number.isFinite(settings.temperature) || settings.temperature <= 0) {
    throw new Error("Opponent policy temperature must be positive and finite");
  }

  const behavior = behaviorCandidates(state, snake.id);
  const space = foodSpaceEstimate(state, snake);
  const scored = fallbackCandidates(state, snake).map((move) => {
    const features = moveFeatures(
      state,
      snake,
      move,
      behavior,
      context,
      space,
    );
    return {
      move,
      features,
      score: weightedScore(features, settings.weights),
    };
  });
  const maximum = Math.max(...scored.map((candidate) => candidate.score));
  const exponentials = scored.map((candidate) =>
    Math.exp((candidate.score - maximum) / settings.temperature),
  );
  const total = exponentials.reduce((sum, value) => sum + value, 0);

  return scored.map((candidate, index) => ({
    ...candidate,
    probability: (exponentials[index] ?? 0) / total,
  }));
}

/**
 * Our PUCT prior uses a desired strategic posture rather than pretending that
 * Nicanelo is one more observed rival. The posture is recalculated for every
 * simulated state, so initiative rises and falls with real strategic capital.
 */
export function policyPriorMoveDistribution(
  state: GameState,
  snakeId: string,
  settings: Readonly<OpponentPolicySettings> = DEFAULT_OPPONENT_POLICY,
): OpponentMoveProbability[] {
  return opponentMoveDistribution(
    state,
    snakeId,
    settings,
    strategicPosture(state, snakeId).context,
  );
}

export function sampleOpponentMove(
  distribution: readonly OpponentMoveProbability[],
  random: RandomSource,
): Direction {
  if (distribution.length === 0) {
    throw new Error("Cannot sample an empty opponent move distribution");
  }

  const target = clamp(random(), 0, 1 - Number.EPSILON);
  let cumulative = 0;
  for (const candidate of distribution) {
    cumulative += candidate.probability;
    if (target < cumulative) {
      return candidate.move;
    }
  }

  return distribution.at(-1)?.move ?? "up";
}
