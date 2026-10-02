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
import { immediateHeadToHeadOutcome } from "../domain/head-to-head.js";
import { analyzeTraps, type EnclosureRisk } from "./traps.js";
import {
  shortestPathToOwnTail,
  shortestSurvivablePathToFood,
} from "./pathfinding.js";

export interface RivalOffensiveAssessment {
  opponentId: string;
  proximity: number;
  currentReachableCells: number;
  projectedReachableCells: number;
  spaceReduction: number;
  exitReduction: number;
  vulnerability: number;
  vulnerabilityGain: number;
  headControl: number;
  pressure: number;
}

/**
 * Tactical offense is intentionally a set of plans, not one personality
 * scalar.  Resource plans are included because safe growth is often the move
 * that creates head-to-head control on a later turn.
 */
export type TacticalIntentKind =
  | "FORCE_H2H"
  | "CONSTRICT_TRAP"
  | "SPACE_DENIAL"
  | "THIRD_PARTY_LEVERAGE"
  | "RESOURCE_GROWTH"
  | "RECOVER"
  | "SURVIVE";

export interface TacticalIntentScores {
  FORCE_H2H: number;
  CONSTRICT_TRAP: number;
  SPACE_DENIAL: number;
  THIRD_PARTY_LEVERAGE: number;
  RESOURCE_GROWTH: number;
  RECOVER: number;
  SURVIVE: number;
}

export interface TacticalIntent {
  kind: TacticalIntentKind;
  score: number;
  targetId?: string;
  /** Attack plans receive no value unless this candidate passes this gate. */
  safetyGate: boolean;
  /** False only when a critical food route exists and this move abandons it. */
  resourceGate: boolean;
  resourceRequired: boolean;
  healthRecoveryRequired: boolean;
  strategicCatchUpRequired: boolean;
  capturesFood: boolean;
  /** One means closer/capture, zero means neutral, and minus one means lost. */
  foodProgress: number;
  currentFoodDistance?: number;
  projectedFoodDistance?: number;
  scores: Readonly<TacticalIntentScores>;
}

export interface OffensiveMoveAnalysis {
  targetId?: string;
  /** Pressure before converting a strict length advantage into extra intent. */
  basePressure: number;
  /** Causal progress made by this move toward constraining the target. */
  constraintProgress: number;
  /** True only when our pre-move length is strictly greater than the target. */
  strictLengthControl: boolean;
  /** Bounded, safety-conditioned pressure enabled by strict length control. */
  advantageConversion: number;
  attackOpportunity: number;
  postAttackSafety: number;
  thirdPartyExposure: number;
  foodControl: number;
  foodContestRisk: number;
  tacticalIntent: Readonly<TacticalIntent>;
  rivals: readonly RivalOffensiveAssessment[];
}

export interface ProjectedOffensiveMove {
  state: GameState;
  snake: Battlesnake;
  blocked: ReadonlySet<string>;
}

/** Maximum share of the existing pressure signal added by length conversion. */
export const ADVANTAGE_CONVERSION_BONUS = 0.25;

/** Below this reserve, a reachable food route becomes a tactical obligation. */
export const TACTICAL_FOOD_HEALTH_FLOOR = 35;
export const TACTICAL_FOOD_ROUTE_RESERVE = 18;
export const TACTICAL_CATCH_UP_MIN_DEFICIT = 2;
export const TACTICAL_CATCH_UP_MAX_DEFICIT = 6;
export const TACTICAL_CATCH_UP_MAX_FOOD_DISTANCE = 6;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function riskValue(risk: EnclosureRisk): number {
  switch (risk) {
    case "low":
      return 0;
    case "moderate":
      return 0.25;
    case "high":
      return 0.75;
    case "critical":
      return 1;
  }
}

function safetyValue(risk: EnclosureRisk): number {
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

/**
 * Keeps offensive pressure phase-aware without making eliminations outweigh
 * survival. Four-snake play stays neutral, while the reduced third-party risk
 * in three-snake and duel phases earns a bounded conversion boost.
 */
export function offensivePhaseBoost(livingSnakeCount: number): number {
  if (livingSnakeCount <= 2) return 1.4;
  if (livingSnakeCount === 3) return 1.2;
  return 1;
}

export function vulnerabilityValue(
  risk: EnclosureRisk,
  tailDistance: number | undefined,
): number {
  const base = riskValue(risk);
  if (
    tailDistance === undefined ||
    (risk !== "high" && risk !== "critical")
  ) {
    return base;
  }
  // A theoretical route to a distant tail is not an immediate escape. Only a
  // nearby tail meaningfully reduces vulnerability, and the relief fades out
  // after six steps just like our own trap-safety feature.
  const confidence = clamp((7 - tailDistance) / 6);
  return base - (base - riskValue("moderate")) * confidence;
}

/**
 * Static flood-fill can call a position critical even when the tail is close
 * enough to provide a credible exit. Preserve a modest amount of initiative
 * in that case, while a critical position with no short tail route remains an
 * absolute offensive veto.
 */
export function offensiveSafetyValue(
  risk: EnclosureRisk,
  tailDistance: number | undefined,
): number {
  return Math.max(
    safetyValue(risk),
    1 - vulnerabilityValue(risk, tailDistance),
  );
}

function occupiedCells(state: Readonly<GameState>): Set<string> {
  return guaranteedOccupiedCells(state as GameState);
}

function assessment(
  before: Readonly<GameState>,
  projected: Readonly<ProjectedOffensiveMove>,
  opponent: Readonly<Battlesnake>,
  beforeBlocked: ReadonlySet<string>,
): RivalOffensiveAssessment {
  const current = analyzeTraps(
    opponent.head,
    before.board.width,
    before.board.height,
    beforeBlocked,
    opponent.length,
  );
  const after = analyzeTraps(
    opponent.head,
    projected.state.board.width,
    projected.state.board.height,
    projected.blocked,
    opponent.length,
  );
  const boardScale = Math.max(
    1,
    projected.state.board.width + projected.state.board.height - 2,
  );
  const distance = manhattanDistance(projected.snake.head, opponent.head);
  const proximity = 1 - clamp(distance / boardScale);
  const spaceReduction = clamp(
    (current.reachableCells - after.reachableCells) /
      Math.max(current.reachableCells, 1),
  );
  const exitReduction = clamp((current.openExits - after.openExits) / 4);
  const currentTailDistance = shortestPathToOwnTail(
    before as GameState,
    opponent as Battlesnake,
    beforeBlocked,
  )?.distance;
  const projectedTailDistance = shortestPathToOwnTail(
    projected.state,
    opponent as Battlesnake,
    projected.blocked,
  )?.distance;
  const currentVulnerability = vulnerabilityValue(
    current.enclosureRisk,
    currentTailDistance,
  );
  const vulnerability = vulnerabilityValue(
    after.enclosureRisk,
    projectedTailDistance,
  );
  const vulnerabilityGain = clamp(
    vulnerability - currentVulnerability,
  );
  const headControl = projected.snake.length > opponent.length && distance <= 2
    ? 1
    : 0;
  const pressure = clamp(
    (
      0.1 * vulnerability +
      0.35 * vulnerabilityGain +
      0.3 * spaceReduction +
      0.15 * exitReduction +
      0.1 * headControl
    ) * (0.5 + 0.5 * proximity),
  );

  return {
    opponentId: opponent.id,
    proximity,
    currentReachableCells: current.reachableCells,
    projectedReachableCells: after.reachableCells,
    spaceReduction,
    exitReduction,
    vulnerability,
    vulnerabilityGain,
    headControl,
    pressure,
  };
}

function foodInteraction(
  state: Readonly<GameState>,
  destination: Readonly<Coordinate>,
  snake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
): Pick<OffensiveMoveAnalysis, "foodControl" | "foodContestRisk"> {
  const eats = state.board.food.some((food) => sameCoordinate(food, destination));
  if (!eats) {
    return { foodControl: 0, foodContestRisk: 0 };
  }

  const nearby = opponents.filter(
    (opponent) => manhattanDistance(opponent.head, destination) <= 2,
  );
  const contenders = nearby.filter(
    (opponent) => manhattanDistance(opponent.head, destination) === 1,
  );
  const foodControl = nearby.length === 0
    ? 0
    : nearby.reduce((total, opponent) => {
      const control = snake.length > opponent.length
        ? 1
        : snake.length === opponent.length
          ? 0.35
          : 0;
      const proximity = manhattanDistance(opponent.head, destination) === 1
        ? 1
        : 0.5;
      return total + control * proximity;
    }, 0) / nearby.length;
  const foodContestRisk = contenders.reduce((maximum, opponent) => {
    const risk = opponent.length > snake.length
      ? 1
      : opponent.length === snake.length
        ? 0.8
        : 0;
    return Math.max(maximum, risk);
  }, 0);

  return { foodControl, foodContestRisk };
}

interface ResourceRouteAnalysis {
  capturesFood: boolean;
  currentFoodDistance?: number;
  projectedFoodDistance?: number;
  foodProgress: number;
  resourceRequired: boolean;
  healthRecoveryRequired: boolean;
  strategicCatchUpRequired: boolean;
  projectedRouteControlled: boolean;
}

function conservativelyControlsFoodRoute(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
  target: Readonly<Coordinate> | undefined,
  eta: number | undefined,
): boolean {
  if (target === undefined || eta === undefined) return false;
  return state.board.snakes.every((opponent) => {
    if (opponent.id === snake.id) return true;
    const opponentEta = manhattanDistance(opponent.head, target);
    return opponentEta > eta ||
      (opponentEta === eta && snake.length > opponent.length);
  });
}

function resourceRouteAnalysis(
  state: Readonly<GameState>,
  direction: Direction,
  projected: Readonly<ProjectedOffensiveMove>,
  beforeBlocked: ReadonlySet<string>,
): ResourceRouteAnalysis {
  const destination = moveCoordinate(state.you.head, direction);
  const capturesFood = state.board.food.some((food) =>
    sameCoordinate(food, destination)
  );
  const currentFoodPath = shortestSurvivablePathToFood(
    state as GameState,
    state.you,
    beforeBlocked,
  );
  const currentFoodDistance = currentFoodPath?.distance;
  const projectedFoodPath = capturesFood
    ? undefined
    : shortestSurvivablePathToFood(
      projected.state,
      projected.snake,
      projected.blocked,
    );
  const projectedFoodDistance = capturesFood
    ? 0
    : projectedFoodPath?.distance;
  const foodProgress = capturesFood
    ? 1
    : currentFoodDistance === undefined
      ? projectedFoodDistance === undefined ? 0 : 0.5
      : projectedFoodDistance === undefined
        ? -1
        : clamp(currentFoodDistance - projectedFoodDistance, -1, 1);
  const routeSlack = currentFoodDistance === undefined
    ? Number.POSITIVE_INFINITY
    : state.you.health - currentFoodDistance;
  const healthRecoveryRequired = state.board.food.length > 0 && (
    state.you.health <= TACTICAL_FOOD_HEALTH_FLOOR ||
    routeSlack <= TACTICAL_FOOD_ROUTE_RESERVE
  );
  const maximumOpponentLength = state.board.snakes.reduce(
    (maximum, snake) => snake.id === state.you.id
      ? maximum
      : Math.max(maximum, snake.length),
    state.you.length,
  );
  const lengthDeficit = Math.max(
    0,
    maximumOpponentLength - state.you.length,
  );
  const currentFoodTarget = currentFoodPath?.path.at(-1);
  const strategicCatchUpRequired =
    lengthDeficit >= TACTICAL_CATCH_UP_MIN_DEFICIT &&
    lengthDeficit <= TACTICAL_CATCH_UP_MAX_DEFICIT &&
    currentFoodDistance !== undefined &&
    currentFoodDistance <= TACTICAL_CATCH_UP_MAX_FOOD_DISTANCE &&
    conservativelyControlsFoodRoute(
      state,
      state.you,
      currentFoodTarget,
      currentFoodDistance,
    );
  const projectedFoodTarget = capturesFood
    ? destination
    : projectedFoodPath?.path.at(-1);
  const projectedFoodEta = capturesFood
    ? 1
    : projectedFoodDistance === undefined
      ? undefined
      : projectedFoodDistance + 1;
  const projectedRouteControlled = conservativelyControlsFoodRoute(
    state,
    projected.snake,
    projectedFoodTarget,
    projectedFoodEta,
  );
  const resourceRequired = healthRecoveryRequired ||
    strategicCatchUpRequired;

  return {
    capturesFood,
    ...(currentFoodDistance === undefined ? {} : { currentFoodDistance }),
    ...(projectedFoodDistance === undefined
      ? {}
      : { projectedFoodDistance }),
    foodProgress,
    resourceRequired,
    healthRecoveryRequired,
    strategicCatchUpRequired,
    projectedRouteControlled,
  };
}

interface ScoredTacticalIntent {
  kind: TacticalIntentKind;
  score: number;
  targetId?: string;
}

const ATTACK_INTENTS: ReadonlySet<TacticalIntentKind> = new Set([
  "FORCE_H2H",
  "CONSTRICT_TRAP",
  "SPACE_DENIAL",
  "THIRD_PARTY_LEVERAGE",
]);

const INTENT_PRIORITY: Readonly<Record<TacticalIntentKind, number>> = {
  RECOVER: 7,
  FORCE_H2H: 6,
  CONSTRICT_TRAP: 5,
  THIRD_PARTY_LEVERAGE: 4,
  SPACE_DENIAL: 3,
  RESOURCE_GROWTH: 2,
  SURVIVE: 1,
};

function bestIntent(
  intents: readonly ScoredTacticalIntent[],
): ScoredTacticalIntent {
  return [...intents].sort(
    (left, right) => right.score - left.score ||
      INTENT_PRIORITY[right.kind] - INTENT_PRIORITY[left.kind] ||
      (left.targetId ?? "").localeCompare(right.targetId ?? ""),
  )[0] ?? { kind: "SURVIVE", score: 0 };
}

function thirdPartyLeverage(
  target: Readonly<Battlesnake>,
  targetAssessment: Readonly<RivalOffensiveAssessment>,
  projectedSnake: Readonly<Battlesnake>,
  opponents: readonly Readonly<Battlesnake>[],
  state: Readonly<GameState>,
  beforeBlocked: ReadonlySet<string>,
): number {
  if (
    targetAssessment.exitReduction <= 0 &&
    targetAssessment.spaceReduction <= 0
  ) return 0;

  return opponents.reduce((maximum, thirdParty) => {
    if (thirdParty.id === target.id || thirdParty.length < target.length) {
      return maximum;
    }
    const targetDistance = manhattanDistance(thirdParty.head, target.head);
    if (targetDistance > 3) return maximum;

    // This is leverage, never assumed cooperation.  A third snake only helps
    // when its independent threat is near the target and is not simultaneously
    // an equal-or-larger head threat to our projected position.
    const threatensUs = thirdParty.length >= projectedSnake.length &&
      manhattanDistance(thirdParty.head, projectedSnake.head) <= 2;
    if (threatensUs) return maximum;
    const controlsIndependentExit = DIRECTIONS.some((direction) => {
      const exit = moveCoordinate(target.head, direction);
      return !sameCoordinate(exit, projectedSnake.head) &&
        isInsideBoard(exit, state.board.width, state.board.height) &&
        (
          !beforeBlocked.has(coordinateKey(exit)) ||
          sameCoordinate(exit, thirdParty.head)
        ) && (
          sameCoordinate(exit, thirdParty.head) ||
          manhattanDistance(thirdParty.head, exit) === 1
        );
    });
    if (!controlsIndependentExit) return maximum;
    return Math.max(maximum, clamp((4 - targetDistance) / 3));
  }, 0);
}

/**
 * Scores a conservative one-move offensive projection. Opponent movement
 * remains stochastic and is resolved by MCTS; this analysis measures only the
 * pressure caused by our candidate body placement.
 */
export function analyzeOffensiveMove(
  state: Readonly<GameState>,
  direction: Direction,
  projected: Readonly<ProjectedOffensiveMove>,
): OffensiveMoveAnalysis {
  const opponents = state.board.snakes.filter(
    (snake) => snake.id !== state.you.id,
  );
  const beforeBlocked = occupiedCells(state);
  const rivals = opponents.map((opponent) =>
    assessment(state, projected, opponent, beforeBlocked)
  );
  const target = [...rivals].sort(
    (a, b) => b.pressure - a.pressure ||
      b.vulnerability - a.vulnerability ||
      a.opponentId.localeCompare(b.opponentId),
  )[0];
  const ownTrap = analyzeTraps(
    projected.snake.head,
    projected.state.board.width,
    projected.state.board.height,
    projected.blocked,
    projected.snake.length,
  );
  const ownTailDistance = shortestPathToOwnTail(
    projected.state,
    projected.snake,
    projected.blocked,
  )?.distance;
  const relativeSpaceCapacity = clamp(
    (ownTrap.relativeSpace - 1) / 2,
  );
  const postAttackSafety = offensiveSafetyValue(
    ownTrap.enclosureRisk,
    ownTailDistance,
  ) *
    (0.5 + 0.5 * relativeSpaceCapacity);
  const thirdParties = opponents.filter(
    (opponent) => opponent.id !== target?.opponentId,
  );
  const dangerousThirdParties = thirdParties.filter(
    (opponent) =>
      opponent.length >= projected.snake.length &&
      manhattanDistance(opponent.head, projected.snake.head) <= 2,
  );
  const thirdPartyExposure = thirdParties.length === 0
    ? 0
    : dangerousThirdParties.length / thirdParties.length;
  const phaseConversionBoost = offensivePhaseBoost(
    state.board.snakes.length,
  );
  const viableAttackSafety = postAttackSafety === 0
    ? 0
    : 0.35 + 0.65 * postAttackSafety;
  const basePressure = clamp(
    (target?.pressure ?? 0) * viableAttackSafety *
      (1 - 0.5 * thirdPartyExposure) * phaseConversionBoost,
  );
  const constraintProgress = target === undefined
    ? 0
    : clamp(
      0.5 * target.vulnerabilityGain +
        0.3 * target.spaceReduction +
        0.2 * target.exitReduction,
    );
  const targetSnake = target === undefined
    ? undefined
    : opponents.find((opponent) => opponent.id === target.opponentId);
  const strictLengthControl = targetSnake !== undefined &&
    // Start converting only after the advantage exists in the observed state.
    // A meal on this move cannot create a winning contested-food edge because
    // every head reaching that food grows before the collision resolves.
    state.you.length > targetSnake.length;
  const immediateHeadOutcome = immediateHeadToHeadOutcome(state, direction);
  const survivalGate = projected.snake.health > 0 && ownTrap.openExits > 0 &&
    immediateHeadOutcome !== "losing";
  const safetyGate = survivalGate && ownTrap.hasEnoughSpace &&
    postAttackSafety > 0;
  const resource = resourceRouteAnalysis(
    state,
    direction,
    projected,
    beforeBlocked,
  );
  const preservesRequiredFood = survivalGate && resource.foodProgress > 0 &&
    (
      !resource.strategicCatchUpRequired ||
      resource.projectedRouteControlled
    );
  const convertsSafeHeadControl =
    !resource.healthRecoveryRequired &&
    resource.strategicCatchUpRequired &&
    safetyGate && immediateHeadOutcome === "winning";
  const resourceGate = !resource.resourceRequired ||
    preservesRequiredFood || convertsSafeHeadControl;
  const safeToConvert = safetyGate && resourceGate;
  // Length is strategic capital, not another independent score. It only
  // amplifies the pressure already caused by this candidate, and only when the
  // candidate makes real constriction progress (or establishes nearby head
  // control). This avoids counting length, trapping, and pressure three times.
  const conversionMerit = target === undefined
    ? 0
    : Math.max(constraintProgress, 0.5 * target.headControl);
  const advantageConversion = strictLengthControl && safeToConvert
    ? clamp(
      basePressure * conversionMerit * postAttackSafety *
        (1 - thirdPartyExposure),
    )
    : 0;
  const food = foodInteraction(
    state,
    moveCoordinate(state.you.head, direction),
    state.you,
    opponents,
  );

  const destination = moveCoordinate(state.you.head, direction);
  const destinationHasFood = state.board.food.some((item) =>
    sameCoordinate(item, destination)
  );
  const destinationHazardDamage = state.board.hazards.some((hazard) =>
      sameCoordinate(hazard, destination)
    )
    ? state.game.ruleset.settings.hazardDamagePerTurn
    : 0;
  const forceTarget = immediateHeadOutcome === "winning"
    ? [...opponents]
      .filter((opponent) =>
        manhattanDistance(opponent.head, destination) === 1 &&
        (
          destinationHasFood ||
          opponent.health - 1 - destinationHazardDamage > 0
        )
      )
      .sort((left, right) =>
        right.length - left.length || left.id.localeCompare(right.id)
      )[0]
    : undefined;
  const forceHeadToHead = forceTarget === undefined ? 0 : 1;
  const constrictTrap = constraintProgress;
  const spaceDenial = target === undefined
    ? 0
    : clamp(
      target.spaceReduction * (0.6 + 0.4 * target.proximity) +
        0.25 * target.exitReduction,
    );
  const leverage = targetSnake === undefined || target === undefined
    ? 0
    : thirdPartyLeverage(
      targetSnake,
      target,
      projected.snake,
      opponents,
      state,
      beforeBlocked,
    );
  const thirdPartyLeverageScore = clamp(
    Math.max(constraintProgress, spaceDenial) * leverage * 1.2,
  );
  const attackAllowed = safetyGate && resourceGate;
  const attackScore = (specificMerit: number): number =>
    attackAllowed && specificMerit > 0
      ? clamp(
        basePressure + 0.25 * specificMerit +
          ADVANTAGE_CONVERSION_BONUS * advantageConversion,
      )
      : 0;

  const maximumOpponentLength = opponents.reduce(
    (maximum, opponent) => Math.max(maximum, opponent.length),
    state.you.length,
  );
  const hasEqualLengthRival = opponents.some(
    (opponent) => opponent.length === state.you.length,
  );
  const controlDeficit = Math.max(
    0,
    maximumOpponentLength - state.you.length,
  );
  const growthNeed = clamp(
    controlDeficit / 4 + Number(hasEqualLengthRival) * 0.35,
  );
  const routeAction = Math.max(0, resource.foodProgress);
  const resourceGrowth = !resource.healthRecoveryRequired && survivalGate &&
      routeAction > 0 && resource.projectedRouteControlled &&
      (!resource.strategicCatchUpRequired || resourceGate)
    ? clamp(
      routeAction * (0.35 + 0.65 * growthNeed) *
        (1 - food.foodContestRisk),
    )
    : 0;
  const routeSlack = resource.currentFoodDistance === undefined
    ? Number.POSITIVE_INFINITY
    : state.you.health - resource.currentFoodDistance;
  const recoveryUrgency = Math.max(
    clamp((45 - state.you.health) / 30),
    Number.isFinite(routeSlack)
      ? clamp((TACTICAL_FOOD_ROUTE_RESERVE - routeSlack) /
        TACTICAL_FOOD_ROUTE_RESERVE)
      : 0,
  );
  const recover = resource.healthRecoveryRequired && resourceGate
    ? clamp(routeAction * (0.65 + 0.35 * recoveryUrgency))
    : 0;
  const scores: TacticalIntentScores = {
    FORCE_H2H: attackScore(forceHeadToHead),
    CONSTRICT_TRAP: attackScore(constrictTrap),
    SPACE_DENIAL: attackScore(spaceDenial),
    THIRD_PARTY_LEVERAGE: attackScore(thirdPartyLeverageScore),
    RESOURCE_GROWTH: resourceGrowth,
    RECOVER: recover,
    SURVIVE: 0,
  };
  const selected = bestIntent(
    (Object.entries(scores) as [TacticalIntentKind, number][])
      .filter(([, score]) => score > 0)
      .map(([kind, score]) => ({
        kind,
        score,
        ...(kind === "FORCE_H2H" && forceTarget !== undefined
          ? { targetId: forceTarget.id }
          : ATTACK_INTENTS.has(kind) && target !== undefined
            ? { targetId: target.opponentId }
          : {}),
      })),
  );
  const tacticalIntent: TacticalIntent = {
    kind: selected.kind,
    score: selected.score,
    ...(selected.targetId === undefined ? {} : { targetId: selected.targetId }),
    safetyGate,
    resourceGate,
    resourceRequired: resource.resourceRequired,
    healthRecoveryRequired: resource.healthRecoveryRequired,
    strategicCatchUpRequired: resource.strategicCatchUpRequired,
    capturesFood: resource.capturesFood,
    foodProgress: resource.foodProgress,
    ...(resource.currentFoodDistance === undefined
      ? {}
      : { currentFoodDistance: resource.currentFoodDistance }),
    ...(resource.projectedFoodDistance === undefined
      ? {}
      : { projectedFoodDistance: resource.projectedFoodDistance }),
    scores,
  };
  // Kept as a compatibility field for evaluation/training consumers.  Its
  // value now comes from the selected attack plan, and resource/survival plans
  // never masquerade as generic aggression.
  const attackOpportunity = ATTACK_INTENTS.has(tacticalIntent.kind)
    ? tacticalIntent.score
    : 0;

  return {
    ...(target === undefined ? {} : { targetId: target.opponentId }),
    basePressure,
    constraintProgress,
    strictLengthControl,
    advantageConversion,
    attackOpportunity,
    postAttackSafety,
    thirdPartyExposure,
    ...food,
    tacticalIntent,
    rivals,
  };
}

/** Selects the most vulnerable relevant rival in an already-resolved state. */
export function offensivePressureInState(
  state: Readonly<GameState>,
  perspectiveId: string,
  blocked: ReadonlySet<string> = occupiedCells(state),
): number {
  const snake = state.board.snakes.find((item) => item.id === perspectiveId);
  if (snake === undefined) return 0;
  const ownTrap = analyzeTraps(
    snake.head,
    state.board.width,
    state.board.height,
    blocked,
    snake.length,
  );
  const ownTailDistance = shortestPathToOwnTail(
    state as GameState,
    snake as Battlesnake,
    blocked,
  )?.distance;
  const ownSafety = offensiveSafetyValue(
    ownTrap.enclosureRisk,
    ownTailDistance,
  );
  if (ownSafety === 0) return 0;
  const boardScale = Math.max(1, state.board.width + state.board.height - 2);
  const opponents = state.board.snakes.filter(
    (opponent) => opponent.id !== perspectiveId,
  );
  const phaseConversionBoost = offensivePhaseBoost(
    state.board.snakes.length,
  );
  return opponents
    .reduce((maximum, opponent) => {
      const trap = analyzeTraps(
        opponent.head,
        state.board.width,
        state.board.height,
        blocked,
        opponent.length,
      );
      const tailDistance = shortestPathToOwnTail(
        state as GameState,
        opponent as Battlesnake,
        blocked,
      )?.distance;
      const proximity = 1 - clamp(
        manhattanDistance(snake.head, opponent.head) / boardScale,
      );
      const headControl = snake.length > opponent.length &&
          manhattanDistance(snake.head, opponent.head) <= 2
        ? 0.15
        : 0;
      const pressure = clamp(
        (vulnerabilityValue(trap.enclosureRisk, tailDistance) *
            (0.6 + 0.4 * proximity) +
          headControl) * ownSafety * phaseConversionBoost,
      );
      return Math.max(maximum, pressure);
    }, 0);
}
