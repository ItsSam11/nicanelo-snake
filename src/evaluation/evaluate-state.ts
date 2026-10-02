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
  manhattanDistance,
  moveCoordinate,
  sameCoordinate,
} from "../domain/board.js";
import {
  shortestPathToOwnTail,
  shortestSurvivablePathToFood,
} from "./pathfinding.js";
import { analyzeSpatialMove } from "./spatial-analysis.js";
import { blendedTerritoryAdvantage } from "./territory.js";
import { analyzeTraps, type EnclosureRisk } from "./traps.js";
import {
  offensivePressureInState,
  type TacticalIntent,
} from "./offense.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "./weights.js";
import {
  foodMotivation,
  growthSpaceCapacity,
  normalizedFoodAccess,
  type FoodMotivationContext,
} from "./food-strategy.js";
import { analyzeEscapeResilience } from "./escape-resilience.js";

export type PerspectiveOutcome = "ongoing" | "win" | "loss" | "draw";

export interface EvaluationFeatures {
  survival: number;
  reachableSpace: number;
  relativeSpace: number;
  territory: number;
  health: number;
  foodAccess: number;
  lengthAdvantage: number;
  mobility: number;
  headToHead: number;
  opponentPressure: number;
  hazardDistance: number;
  wallDistance: number;
  tailAccess: number;
  trapSafety: number;
}

export interface EvaluationResult {
  total: number;
  outcome: PerspectiveOutcome;
  terminalScore: number;
  features: Readonly<EvaluationFeatures>;
  contributions: Readonly<EvaluationFeatures>;
}

export interface MoveEvaluationResult extends EvaluationResult {
  tacticalIntent: Readonly<TacticalIntent>;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function zeroFeatures(): EvaluationFeatures {
  return {
    survival: 0,
    reachableSpace: 0,
    relativeSpace: 0,
    territory: 0,
    health: 0,
    foodAccess: 0,
    lengthAdvantage: 0,
    mobility: 0,
    headToHead: 0,
    opponentPressure: 0,
    hazardDistance: 0,
    wallDistance: 0,
    tailAccess: 0,
    trapSafety: 0,
  };
}

function perspectiveOutcome(
  state: GameState,
  perspectiveId: string,
): PerspectiveOutcome {
  const alive = state.board.snakes;
  if (alive.length === 0) {
    return "draw";
  }
  if (alive.length === 1) {
    return alive[0]?.id === perspectiveId ? "win" : "loss";
  }
  return alive.some((snake) => snake.id === perspectiveId)
    ? "ongoing"
    : "loss";
}

function terminalScore(
  outcome: PerspectiveOutcome,
  weights: Readonly<EvaluationWeights>,
): number {
  switch (outcome) {
    case "win":
      return weights.terminalWin;
    case "loss":
      return weights.terminalLoss;
    case "draw":
      return weights.terminalDraw;
    case "ongoing":
      return 0;
  }
}

function occupiedCells(state: GameState): Set<string> {
  return guaranteedOccupiedCells(state);
}

function occupiedBodyCellCount(state: GameState): number {
  return new Set(
    state.board.snakes.flatMap((snake) => snake.body.map(coordinateKey)),
  ).size;
}

const TACTICAL_LENGTH_DISTANCE = 6;

function tacticalLengthAdvantage(
  length: number,
  origin: Readonly<Coordinate>,
  opponents: readonly Battlesnake[],
  reachableCells: number,
  enclosureRisk: EnclosureRisk,
): number {
  const localAdvantage = opponents.reduce((maximum, opponent) => {
    // Local head-to-head control starts at one extra segment and then
    // saturates. Existing size remains tactically useful, but another meal
    // cannot increase this feature or create an incentive to chase a gap.
    if (length <= opponent.length) return maximum;
    const distance = manhattanDistance(origin, opponent.head);
    const proximity = clamp(
      (TACTICAL_LENGTH_DISTANCE + 1 - distance) /
        TACTICAL_LENGTH_DISTANCE,
    );
    return Math.max(maximum, proximity);
  }, 0);
  return localAdvantage * growthSpaceCapacity(
    length,
    reachableCells,
    enclosureRisk,
  );
}

function foodAccessFeature(
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  distance: number | undefined,
  hasFood: boolean,
  width: number,
  height: number,
  reachableCells: number,
  enclosureRisk: EnclosureRisk,
  boardArea: number,
  occupiedBodyCells: number,
  origin: Readonly<Coordinate> = snake.head,
  tacticalContext: Readonly<Pick<
    FoodMotivationContext,
    "currentFoodDistance" | "capturesFood" | "foodRaceControl" | "openExits"
  >> = {},
): number {
  return normalizedFoodAccess(
    foodMotivation(snake, opponents, {
      ...(distance === undefined ? {} : { foodDistance: distance }),
      reachableCells,
      enclosureRisk,
      origin,
      boardArea,
      occupiedCells: occupiedBodyCells,
      ...tacticalContext,
    }),
    distance,
    hasFood,
    width,
    height,
  );
}

function conservativeFoodRaceControl(
  state: Readonly<GameState>,
  target: Readonly<Coordinate> | undefined,
  ourEta: number | undefined,
): number {
  if (target === undefined || ourEta === undefined) return 0;
  let control = 1;
  for (const opponent of state.board.snakes) {
    if (opponent.id === state.you.id) continue;
    const opponentEta = manhattanDistance(opponent.head, target);
    const margin = opponentEta - ourEta;
    if (margin < 0) return 0;
    if (margin === 0) {
      if (opponent.length >= state.you.length) return 0;
      control = Math.min(control, 0.6);
    } else if (margin === 1) {
      control = Math.min(control, 0.8);
    }
  }
  return control;
}

function hazardDistanceFeature(
  origin: Coordinate,
  hazards: readonly Coordinate[],
  width: number,
  height: number,
): number {
  if (hazards.length === 0) {
    return 1;
  }
  const distance = Math.min(
    ...hazards.map((hazard) => manhattanDistance(origin, hazard)),
  );
  return clamp(distance / Math.max(width + height - 2, 1));
}

function wallDistanceFeature(
  origin: Coordinate,
  width: number,
  height: number,
): number {
  const distance = Math.min(
    origin.x,
    origin.y,
    width - 1 - origin.x,
    height - 1 - origin.y,
  );
  return clamp(distance / Math.max(Math.floor(Math.min(width, height) / 2), 1));
}

function tailAccessFeature(
  distance: number | undefined,
  width: number,
  height: number,
): number {
  if (distance === undefined) return 0;
  return clamp(
    1 - distance / Math.max(width + height - 2, 1),
  );
}

function trapSafetyFeature(
  risk: EnclosureRisk,
  tailDistance: number | undefined,
): number {
  const base = (() => {
    switch (risk) {
    case "low":
      return 1;
    case "moderate":
      return 0.25;
    case "high":
      return -0.5;
    case "critical":
      return -1;
    }
  })();
  if (tailDistance === undefined || (risk !== "high" && risk !== "critical")) {
    return base;
  }

  // A nearby tail can make a static flood-fill less pessimistic, but it is not
  // equivalent to open space: the path may be contested or disappear as other
  // snakes move. Relief fades after six steps and never turns danger positive.
  const confidence = clamp((7 - tailDistance) / 6);
  const maximumRelief = risk === "critical" ? 0.5 : 0.25;
  return base + maximumRelief * confidence;
}

function headToHeadFeatureAt(
  state: GameState,
  head: Coordinate,
  length: number,
  perspectiveId: string,
): number {
  let score = 0;
  const occupied = guaranteedOccupiedCells(state);
  const food = new Set(state.board.food.map(coordinateKey));
  const hazards = new Set(state.board.hazards.map(coordinateKey));

  for (const direction of DIRECTIONS) {
    const candidate = moveCoordinate(head, direction);
    const candidateKey = coordinateKey(candidate);
    if (!isInsideBoard(candidate, state.board.width, state.board.height)) {
      continue;
    }

    const contenders = state.board.snakes.filter(
      (snake) => {
        if (snake.id === perspectiveId || occupied.has(candidateKey)) {
          return false;
        }

        const reachesCandidate = DIRECTIONS.some((opponentDirection) =>
          sameCoordinate(
            moveCoordinate(snake.head, opponentDirection),
            candidate,
          ),
        );
        if (!reachesCandidate) {
          return false;
        }

        if (food.has(candidateKey)) {
          return true;
        }

        const hazardDamage = hazards.has(candidateKey)
          ? state.game.ruleset.settings.hazardDamagePerTurn
          : 0;
        return snake.health - 1 - hazardDamage > 0;
      },
    );
    if (contenders.length === 0) {
      continue;
    }

    const longest = Math.max(...contenders.map((snake) => snake.length));
    score += length > longest ? 1 : -1;
  }

  return clamp(score / 4, -1, 1);
}

function territoryFeature(
  state: GameState,
  perspectiveId: string,
  blocked: ReadonlySet<string>,
): number {
  return blendedTerritoryAdvantage(state, perspectiveId, blocked);
}

function scoreFeatures(
  features: EvaluationFeatures,
  weights: Readonly<EvaluationWeights>,
  outcome: PerspectiveOutcome,
): EvaluationResult {
  const contributions: EvaluationFeatures = {
    survival: features.survival * weights.survival,
    reachableSpace: features.reachableSpace * weights.reachableSpace,
    relativeSpace: features.relativeSpace * weights.relativeSpace,
    territory: features.territory * weights.territory,
    health: features.health * weights.health,
    foodAccess: features.foodAccess * weights.foodAccess,
    lengthAdvantage: features.lengthAdvantage * weights.lengthAdvantage,
    mobility: features.mobility * weights.mobility,
    headToHead: features.headToHead * weights.headToHead,
    opponentPressure: features.opponentPressure * weights.opponentPressure,
    hazardDistance: features.hazardDistance * weights.hazardDistance,
    wallDistance: features.wallDistance * weights.wallDistance,
    tailAccess: features.tailAccess * weights.tailAccess,
    trapSafety: features.trapSafety * weights.trapSafety,
  };
  const terminal = terminalScore(outcome, weights);
  const total =
    terminal +
    Object.values(contributions).reduce((sum, value) => sum + value, 0);

  return { total, outcome, terminalScore: terminal, features, contributions };
}

export function evaluateState(
  state: GameState,
  perspectiveId = state.you.id,
  weights: Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
): EvaluationResult {
  const outcome = perspectiveOutcome(state, perspectiveId);
  if (outcome !== "ongoing") {
    return scoreFeatures(zeroFeatures(), weights, outcome);
  }

  const snake = state.board.snakes.find((item) => item.id === perspectiveId);
  if (snake === undefined) {
    return scoreFeatures(zeroFeatures(), weights, "loss");
  }

  const blocked = occupiedCells(state);
  const traps = analyzeTraps(
    snake.head,
    state.board.width,
    state.board.height,
    blocked,
    snake.length,
  );
  const foodPath = shortestSurvivablePathToFood(state, snake, blocked);
  const tailPath = shortestPathToOwnTail(state, snake, blocked);
  const opponents = state.board.snakes.filter(
    (item) => item.id !== perspectiveId,
  );
  const boardArea = Math.max(state.board.width * state.board.height, 1);
  const escape = analyzeEscapeResilience(state, perspectiveId);
  const features: EvaluationFeatures = {
    survival: 1,
    reachableSpace: traps.reachableCells / boardArea,
    relativeSpace: clamp(traps.relativeSpace / 4),
    territory: territoryFeature(state, perspectiveId, blocked),
    health: clamp(snake.health / 100),
    foodAccess: foodAccessFeature(
      snake,
      opponents,
      foodPath?.distance,
      state.board.food.length > 0,
      state.board.width,
      state.board.height,
      traps.reachableCells,
      traps.enclosureRisk,
      boardArea,
      occupiedBodyCellCount(state),
    ),
    lengthAdvantage: tacticalLengthAdvantage(
      snake.length,
      snake.head,
      opponents,
      traps.reachableCells,
      traps.enclosureRisk,
    ),
    mobility: clamp(traps.openExits / 4),
    headToHead: headToHeadFeatureAt(
      state,
      snake.head,
      snake.length,
      perspectiveId,
    ),
    opponentPressure: offensivePressureInState(
      state,
      perspectiveId,
      blocked,
    ),
    hazardDistance: hazardDistanceFeature(
      snake.head,
      state.board.hazards,
      state.board.width,
      state.board.height,
    ),
    wallDistance: wallDistanceFeature(
      snake.head,
      state.board.width,
      state.board.height,
    ),
    tailAccess: tailAccessFeature(
      tailPath?.distance,
      state.board.width,
      state.board.height,
    ),
    trapSafety: Math.min(
      trapSafetyFeature(traps.enclosureRisk, tailPath?.distance),
      escape.score,
    ),
  };

  return scoreFeatures(features, weights, outcome);
}

export function evaluateMove(
  state: GameState,
  direction: Direction,
  weights: Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
): MoveEvaluationResult {
  const analysis = analyzeSpatialMove(state, direction);
  const opponents = state.board.snakes.filter(
    (snake) => snake.id !== state.you.id,
  );
  const destinationHasFood = state.board.food.some((food) =>
    sameCoordinate(food, analysis.destination),
  );
  const projectedLength = state.you.length + Number(destinationHasFood);
  const boardArea = Math.max(state.board.width * state.board.height, 1);
  const currentFoodDistance = shortestSurvivablePathToFood(
    state,
    state.you,
    guaranteedOccupiedCells(state),
  )?.distance;
  const tacticalFoodTarget = destinationHasFood
    ? analysis.destination
    : analysis.safeFoodTarget;
  const tacticalFoodEta = destinationHasFood
    ? 1
    : analysis.safeFoodDistance === undefined
      ? undefined
      : analysis.safeFoodDistance + 1;
  const projectedEscape = analyzeEscapeResilience(
    state,
    state.you.id,
    direction,
  );
  const features: EvaluationFeatures = {
    survival: analysis.projectedHealth > 0 ? 1 : 0,
    reachableSpace: analysis.trap.reachableCells / boardArea,
    relativeSpace: clamp(analysis.trap.relativeSpace / 4),
    territory: analysis.territoryAdvantage,
    health: clamp(analysis.projectedHealth / 100),
    foodAccess: clamp(
      foodAccessFeature(
        state.you,
        opponents,
        destinationHasFood ? 0 : analysis.safeFoodDistance,
        destinationHasFood || state.board.food.length > 0,
        state.board.width,
        state.board.height,
        analysis.trap.reachableCells,
        analysis.trap.enclosureRisk,
        boardArea,
        occupiedBodyCellCount(state) + Number(destinationHasFood),
        analysis.destination,
        {
          ...(currentFoodDistance === undefined
            ? {}
            : { currentFoodDistance }),
          capturesFood: destinationHasFood,
          foodRaceControl: conservativeFoodRaceControl(
            state,
            tacticalFoodTarget,
            tacticalFoodEta,
          ),
          openExits: analysis.trap.openExits,
        },
      ) + (destinationHasFood
        ? 0.2 * analysis.offense.foodControl -
          0.35 * analysis.offense.foodContestRisk
        : 0),
      -1,
      1,
    ),
    lengthAdvantage: tacticalLengthAdvantage(
      projectedLength,
      analysis.destination,
      opponents,
      analysis.trap.reachableCells,
      analysis.trap.enclosureRisk,
    ),
    mobility: clamp(analysis.trap.openExits / 4),
    headToHead: headToHeadFeatureAt(
      state,
      analysis.destination,
      projectedLength,
      state.you.id,
    ),
    opponentPressure: analysis.offense.attackOpportunity,
    hazardDistance: hazardDistanceFeature(
      analysis.destination,
      state.board.hazards,
      state.board.width,
      state.board.height,
    ),
    wallDistance: wallDistanceFeature(
      analysis.destination,
      state.board.width,
      state.board.height,
    ),
    tailAccess: tailAccessFeature(
      analysis.tailDistance,
      state.board.width,
      state.board.height,
    ),
    trapSafety: Math.min(
      trapSafetyFeature(
        analysis.trap.enclosureRisk,
        analysis.tailDistance,
      ),
      projectedEscape.score,
    ),
  };

  return {
    ...scoreFeatures(features, weights, "ongoing"),
    tacticalIntent: analysis.offense.tacticalIntent,
  };
}
