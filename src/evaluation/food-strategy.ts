import type { Battlesnake, Coordinate } from "../api/types.js";
import { manhattanDistance } from "../domain/board.js";
import type { EnclosureRisk } from "./traps.js";

const HUNGER_HEALTH_THRESHOLD = 70;
const FOOD_ROUTE_HEALTH_RESERVE = 45;
const MAINTENANCE_APPETITE_MINIMUM = 0.08;
const MAINTENANCE_APPETITE_RANGE = 0.12;
const TACTICAL_GROWTH_CAP = 0.18;
const CATCH_UP_GROWTH_CAP = 0.12;
const CATCH_UP_TARGET_RATIO = 0.8;
const TACTICAL_RELEVANCE_DISTANCE = 6;
const CATCH_UP_RELEVANCE_DISTANCE = 10;
const MAINTENANCE_SPACE_FLOOR = 0.65;
const TACTICAL_SPACE_FLOOR = 0;
const CATCH_UP_OCCUPANCY_START = 0.35;
const CATCH_UP_OCCUPANCY_END = 0.6;
const CATCH_UP_PEAK_DEFICIT = 4;
const CATCH_UP_MAX_RECOVERABLE_DEFICIT = 10;
const SAFE_GROWTH_CONVERSION_CAP = 0.55;
const SAFE_GROWTH_ROUTE_DISTANCE = 8;

export interface FoodMotivationContext {
  /** Best available food-distance estimate. Undefined also covers unreachable food. */
  foodDistance?: number;
  reachableCells: number;
  enclosureRisk: EnclosureRisk;
  /** Candidate position when evaluating a move; otherwise the current head. */
  origin?: Readonly<Coordinate>;
  boardArea?: number;
  occupiedCells?: number;
  /** Distance before the candidate move, used to reward actual route progress. */
  currentFoodDistance?: number;
  /** True when the candidate consumes food on this turn. */
  capturesFood?: boolean;
  /** Conservative control of the race to the selected food, from 0 to 1. */
  foodRaceControl?: number;
  /** Available exits after the candidate move. */
  openExits?: number;
}

export interface FoodMotivationAnalysis {
  healthUrgency: number;
  maintenanceAppetite: number;
  tacticalOpportunity: number;
  catchUpOpportunity: number;
  safeGrowthConversion: number;
  spaceCapacity: number;
  maintenanceAppetiteScale: number;
  tacticalAppetiteScale: number;
  total: number;
}

function safeGrowthConversion(
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  context: Readonly<FoodMotivationContext>,
  spaceCapacity: number,
): number {
  if (
    context.foodDistance === undefined ||
    context.foodRaceControl === undefined ||
    context.foodRaceControl <= 0 ||
    opponents.length === 0
  ) {
    return 0;
  }

  const captures = context.capturesFood === true;
  const progress = context.currentFoodDistance === undefined
    ? 0
    : Math.max(0, context.currentFoodDistance - context.foodDistance);
  if (!captures && progress === 0) {
    return 0;
  }

  const longestOpponent = opponents.reduce(
    (maximum, opponent) => Math.max(maximum, opponent.length),
    0,
  );
  // Once Nicanelo already owns strict head-to-head control, ordinary
  // maintenance still applies but tactical conversion yields to pressure and
  // territory. Equal length retains a bounded opportunity to create control.
  if (snake.length > longestOpponent) {
    return 0;
  }
  const deficit = Math.max(0, longestOpponent - snake.length);
  const recoverability = deficit <= CATCH_UP_PEAK_DEFICIT
    ? 1
    : clamp(
      (CATCH_UP_MAX_RECOVERABLE_DEFICIT - deficit) /
        (CATCH_UP_MAX_RECOVERABLE_DEFICIT - CATCH_UP_PEAK_DEFICIT),
    );
  const competitiveNeed = (deficit === 0
    ? 0.55
    : 0.65 + 0.35 * clamp(deficit / 4)) * recoverability;
  if (competitiveNeed === 0) {
    return 0;
  }

  const routeCommitment = captures
    ? 1
    : 0.55 * clamp(
      (SAFE_GROWTH_ROUTE_DISTANCE + 1 - context.foodDistance) /
        SAFE_GROWTH_ROUTE_DISTANCE,
    ) * clamp(progress);
  const occupancy = context.boardArea === undefined ||
      context.occupiedCells === undefined
    ? 0
    : context.occupiedCells / Math.max(1, context.boardArea);
  // Open-board growth naturally fades as bodies fill the map; this avoids a
  // brittle hard-coded early-turn phase and works on non-standard board sizes.
  const openBoardCapacity = 1 - clamp((occupancy - 0.25) / 0.4);
  const exitCapacity = context.openExits === undefined
    ? 0
    : context.openExits >= 2
      ? 1
      : context.openExits === 1
        ? 0.35
        : 0;

  return SAFE_GROWTH_CONVERSION_CAP * routeCommitment * competitiveNeed *
    clamp(context.foodRaceControl) * openBoardCapacity * spaceCapacity *
    exitCapacity;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function riskCapacity(risk: EnclosureRisk): number {
  switch (risk) {
    case "low":
      return 1;
    case "moderate":
      return 0.7;
    case "high":
      return 0.3;
    case "critical":
      return 0;
  }
}

export function growthSpaceCapacity(
  snakeLength: number,
  reachableCells: number,
  risk: EnclosureRisk,
): number {
  const relativeSpace = Math.max(reachableCells, 0) / Math.max(snakeLength, 1);
  // One body-length of space is survival room, not comfortable growth room.
  // Optional growth reaches full strength once three body-lengths are reachable.
  return clamp((relativeSpace - 1) / 2) * riskCapacity(risk);
}

function tacticalGrowthOpportunity(
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  context: Readonly<FoodMotivationContext>,
): number {
  if (context.foodDistance === undefined) {
    return 0;
  }

  const foodTimeliness = clamp(
    (TACTICAL_RELEVANCE_DISTANCE - context.foodDistance) /
      TACTICAL_RELEVANCE_DISTANCE,
  );
  if (foodTimeliness === 0) {
    return 0;
  }

  const origin = context.origin ?? snake.head;
  const relevance = opponents.reduce((maximum, opponent) => {
    // One growth step changes an equal head-to-head into a winning one. Large
    // length gaps do not create an open-ended mandate to chase food.
    if (opponent.length !== snake.length) {
      return maximum;
    }
    const distance = manhattanDistance(origin, opponent.head);
    const proximity = clamp(
      (TACTICAL_RELEVANCE_DISTANCE + 1 - distance) /
        TACTICAL_RELEVANCE_DISTANCE,
    );
    return Math.max(maximum, proximity);
  }, 0);

  return TACTICAL_GROWTH_CAP * foodTimeliness * relevance;
}

function boundedCatchUpOpportunity(
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  context: Readonly<FoodMotivationContext>,
): number {
  if (context.foodDistance === undefined || opponents.length === 0) return 0;
  const foodTimeliness = clamp(
    (CATCH_UP_RELEVANCE_DISTANCE - context.foodDistance) /
      CATCH_UP_RELEVANCE_DISTANCE,
  );
  if (foodTimeliness === 0) return 0;

  const origin = context.origin ?? snake.head;
  const strategicNeed = opponents.reduce((maximum, opponent) => {
    const ratioTarget = Math.ceil(opponent.length * CATCH_UP_TARGET_RATIO);
    // In a duel, a one-cell deficit is strategically meaningful even when we
    // already exceed the broad 80% target. Ask for at most two immediate meals
    // toward head-to-head control; equal/ahead snakes use no catch-up term.
    const controlDeficit = opponent.length - snake.length;
    const controlTarget = opponents.length === 1 &&
        controlDeficit > 0 && controlDeficit <= 2
      ? Math.min(opponent.length + 1, snake.length + 2)
      : snake.length;
    const targetLength = Math.max(ratioTarget, controlTarget);
    const deficit = targetLength - snake.length;
    if (deficit <= 0) return maximum;
    const proximity = clamp(
      (CATCH_UP_RELEVANCE_DISTANCE + 1 -
        manhattanDistance(origin, opponent.head)) /
        CATCH_UP_RELEVANCE_DISTANCE,
    );
    // A duel rival controls the whole remaining objective even when its head is
    // currently far away. Multiplayer catch-up stays local and weaker.
    const relevance = opponents.length === 1
      ? 0.55 + 0.45 * proximity
      : proximity;
    const recoverability = deficit <= CATCH_UP_PEAK_DEFICIT
      ? deficit / CATCH_UP_PEAK_DEFICIT
      : clamp(
        (CATCH_UP_MAX_RECOVERABLE_DEFICIT - deficit) /
          (CATCH_UP_MAX_RECOVERABLE_DEFICIT - CATCH_UP_PEAK_DEFICIT),
      );
    return Math.max(maximum, recoverability * relevance);
  }, 0);
  if (strategicNeed === 0) return 0;

  const occupancy = context.boardArea === undefined ||
      context.occupiedCells === undefined
    ? 0
    : context.occupiedCells / Math.max(1, context.boardArea);
  const occupancyCapacity = 1 - clamp(
    (occupancy - CATCH_UP_OCCUPANCY_START) /
      (CATCH_UP_OCCUPANCY_END - CATCH_UP_OCCUPANCY_START),
  );
  const stageScale = 1 / Math.sqrt(opponents.length);
  return CATCH_UP_GROWTH_CAP * foodTimeliness * strategicNeed *
    occupancyCapacity * stageScale;
}

/**
 * Separates food needed for survival from optional maintenance, local tactical
 * growth, and bounded catch-up. Catch-up normally stops at 80% of a rival; in
 * a duel it may ask for at most two near-term meals to erase a small losing
 * head-to-head deficit. It fades with occupancy and irrecoverable deficits and
 * never creates an open-ended mandate to become globally longest.
 */
export function analyzeFoodMotivation(
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  context: Readonly<FoodMotivationContext>,
): FoodMotivationAnalysis {
  const hunger = clamp(
    (HUNGER_HEALTH_THRESHOLD - snake.health) / HUNGER_HEALTH_THRESHOLD,
  );
  const routeUrgency = context.foodDistance === undefined
    ? 0
    : clamp(
      (FOOD_ROUTE_HEALTH_RESERVE -
        (snake.health - context.foodDistance)) /
        FOOD_ROUTE_HEALTH_RESERVE,
    );
  const healthUrgency = Math.max(hunger, routeUrgency);
  const maintenanceAppetite = MAINTENANCE_APPETITE_MINIMUM +
    MAINTENANCE_APPETITE_RANGE * clamp((85 - snake.health) / 65);
  const tacticalOpportunity = tacticalGrowthOpportunity(
    snake,
    opponents,
    context,
  );
  const catchUpOpportunity = boundedCatchUpOpportunity(
    snake,
    opponents,
    context,
  );
  const spaceCapacity = growthSpaceCapacity(
    snake.length + 1,
    context.reachableCells,
    context.enclosureRisk,
  );
  const maintenanceAppetiteScale = MAINTENANCE_SPACE_FLOOR +
    (1 - MAINTENANCE_SPACE_FLOOR) * spaceCapacity;
  const tacticalAppetiteScale = TACTICAL_SPACE_FLOOR +
    (1 - TACTICAL_SPACE_FLOOR) * spaceCapacity;
  const safeGrowth = safeGrowthConversion(
    snake,
    opponents,
    context,
    spaceCapacity,
  );
  const optionalAppetite =
    maintenanceAppetite * maintenanceAppetiteScale +
    (tacticalOpportunity + catchUpOpportunity) * tacticalAppetiteScale +
    safeGrowth;
  const total = clamp(Math.max(healthUrgency, optionalAppetite));

  return {
    healthUrgency,
    maintenanceAppetite,
    tacticalOpportunity,
    catchUpOpportunity,
    safeGrowthConversion: safeGrowth,
    spaceCapacity,
    maintenanceAppetiteScale,
    tacticalAppetiteScale,
    total,
  };
}

export function foodMotivation(
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  context: Readonly<FoodMotivationContext>,
): number {
  return analyzeFoodMotivation(snake, opponents, context).total;
}

export function normalizedFoodAccess(
  motivation: number,
  distance: number | undefined,
  hasFood: boolean,
  width: number,
  height: number,
): number {
  if (!hasFood || motivation === 0) {
    return 0;
  }
  if (distance === undefined) {
    return -motivation;
  }

  const distanceScale = Math.max(width + height - 2, 1);
  return motivation * (1 - clamp(distance / distanceScale));
}
