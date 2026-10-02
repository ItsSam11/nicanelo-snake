import type {
  Battlesnake,
  Coordinate,
  Direction,
  GameState,
} from "../api/types.js";
import {
  coordinateKey,
  countOpenNeighbours,
  dangerousHeadToHeadCells,
  guaranteedOccupiedCells,
  manhattanDistance,
  moveCoordinate,
  sameCoordinate,
} from "../domain/board.js";
import { healthAfterMove } from "../evaluation/spatial-analysis.js";
import { physicallyViableMoves } from "../strategy/static-policy.js";

export const BEHAVIOR_DIMENSIONS = [
  "aggression",
  "resourceAcquisition",
  "healthManagement",
  "conservatism",
] as const;

export type BehaviorDimension = typeof BEHAVIOR_DIMENSIONS[number];

export interface BehaviorScores {
  aggression: number;
  resourceAcquisition: number;
  healthManagement: number;
  conservatism: number;
}

export type BehaviorOpportunityCounts = BehaviorScores;

export interface BehaviorConfidence extends BehaviorScores {
  overall: number;
}

export interface BehaviorHistorySnapshot {
  scores: BehaviorScores;
  opportunities: BehaviorOpportunityCounts;
  confidence: BehaviorConfidence;
  decisionsObserved: number;
  decisionDenseTurns: number;
  decisionDensity: number;
}

export interface BehaviorCandidate {
  move: Direction;
  utilities: BehaviorScores;
}

export interface BehaviorDecision {
  chosen: BehaviorScores;
  opportunities: Record<BehaviorDimension, boolean>;
  decisionDense: boolean;
  candidateCount: number;
}

export function inferObservedDirection(
  before: Readonly<Battlesnake>,
  after: Readonly<Battlesnake>,
): Direction | undefined {
  const dx = after.head.x - before.head.x;
  const dy = after.head.y - before.head.y;
  if (dx === 0 && dy === 1) return "up";
  if (dx === 0 && dy === -1) return "down";
  if (dx === -1 && dy === 0) return "left";
  if (dx === 1 && dy === 0) return "right";
  return undefined;
}

interface MutableBehaviorHistory {
  sums: BehaviorScores;
  opportunities: BehaviorOpportunityCounts;
  decisionsObserved: number;
  decisionDenseTurns: number;
}

const NEUTRAL_SCORE = 0.5;
const MINIMUM_OPPORTUNITY_SPREAD = 0.08;

function zeroScores(): BehaviorScores {
  return {
    aggression: 0,
    resourceAcquisition: 0,
    healthManagement: 0,
    conservatism: 0,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function perspectiveState(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
): GameState {
  return { ...state, you: snake as Battlesnake };
}

function minimumDistance(
  origin: Readonly<Coordinate>,
  targets: readonly Coordinate[],
): number | undefined {
  if (targets.length === 0) return undefined;
  return Math.min(...targets.map((target) => manhattanDistance(origin, target)));
}

function normalizedDistanceGain(
  before: number | undefined,
  after: number | undefined,
  scale: number,
): number {
  if (before === undefined || after === undefined) return 0;
  return (before - after) / Math.max(1, scale);
}

function wallDistance(
  state: Readonly<GameState>,
  destination: Readonly<Coordinate>,
): number {
  const distance = Math.min(
    destination.x,
    destination.y,
    state.board.width - 1 - destination.x,
    state.board.height - 1 - destination.y,
  );
  return clamp01(
    distance /
      Math.max(1, Math.floor(Math.min(state.board.width, state.board.height) / 2)),
  );
}

function contestPressure(
  state: Readonly<GameState>,
  snake: Readonly<Battlesnake>,
  destination: Readonly<Coordinate>,
): number {
  const opponents = state.board.snakes.filter((item) => item.id !== snake.id);
  if (opponents.length === 0) return 0;
  const contestable = opponents.filter((opponent) =>
    manhattanDistance(destination, opponent.head) === 1
  );
  if (contestable.length === 0) return 0;
  // A strict length lead is real control. An equal contest is not favorable,
  // but it is still meaningful aggressive behavior because both snakes would
  // be eliminated; keep it neutral rather than treating it like a winning
  // head-to-head or ignoring it in the learned opponent model.
  return contestable.reduce((total, opponent) =>
    total + (snake.length > opponent.length
      ? 1
      : snake.length === opponent.length
        ? 0.5
        : 0), 0) / contestable.length;
}

function foodCapture(
  state: Readonly<GameState>,
  destination: Readonly<Coordinate>,
): number {
  return Number(state.board.food.some((food) => sameCoordinate(food, destination)));
}

/**
 * Scores every physically viable action using only information available before
 * the move. Values are descriptive utilities; only their within-state ordering
 * is used to infer a behavioral choice.
 */
export function behaviorCandidates(
  state: Readonly<GameState>,
  snakeId: string,
): BehaviorCandidate[] {
  const snake = state.board.snakes.find((item) => item.id === snakeId);
  if (snake === undefined) return [];
  const perspective = perspectiveState(state, snake);
  const moves = physicallyViableMoves(perspective);
  const occupied = guaranteedOccupiedCells(perspective);
  const headThreats = dangerousHeadToHeadCells(perspective);
  const hazards = new Set(state.board.hazards.map(coordinateKey));
  const opponents = state.board.snakes.filter((item) => item.id !== snake.id);
  const opponentHeads = opponents.map((opponent) => opponent.head);
  const currentOpponentDistance = minimumDistance(snake.head, opponentHeads);
  const currentFoodDistance = minimumDistance(snake.head, state.board.food);
  const boardScale = Math.max(1, state.board.width + state.board.height - 2);
  const currentMobility = moves.length / 4;

  return moves.map((move) => {
    const destination = moveCoordinate(snake.head, move);
    const opponentGain = normalizedDistanceGain(
      currentOpponentDistance,
      minimumDistance(destination, opponentHeads),
      boardScale,
    );
    const foodGain = normalizedDistanceGain(
      currentFoodDistance,
      minimumDistance(destination, state.board.food),
      boardScale,
    );
    const capture = foodCapture(state, destination);
    const mobility = countOpenNeighbours(destination, perspective, occupied) / 4;
    const headSafety = Number(!headThreats.has(coordinateKey(destination)));
    const hazardSafety = Number(!hazards.has(coordinateKey(destination)));
    const pressure = contestPressure(state, snake, destination);
    const hunger = clamp01((70 - snake.health) / 70);
    const resource = clamp01(0.65 * Math.max(0, foodGain) + 0.35 * capture);
    const escapeGain = Math.max(0, mobility - currentMobility);
    const aggression =
      0.65 * opponentGain + 0.35 * pressure -
      0.35 * resource - 0.2 * escapeGain;
    const projectedHealth = healthAfterMove(perspective, destination) / 100;
    const healthManagement = clamp01(
      hunger * (0.55 * resource + 0.25 * hazardSafety + 0.2 * mobility) +
        (1 - hunger) *
          (0.4 * projectedHealth + 0.25 * hazardSafety + 0.35 * mobility),
    );
    const conservatism = clamp01(
      0.35 * mobility + 0.25 * headSafety + 0.2 * hazardSafety +
        0.2 * wallDistance(state, destination) - 0.25 * pressure,
    );
    return {
      move,
      utilities: {
        aggression: rounded(aggression),
        resourceAcquisition: rounded(resource),
        healthManagement: rounded(healthManagement),
        conservatism: rounded(conservatism),
      },
    };
  });
}

export function behaviorDecision(
  state: Readonly<GameState>,
  snakeId: string,
  chosenMove: Direction,
): BehaviorDecision | undefined {
  const candidates = behaviorCandidates(state, snakeId);
  const chosen = candidates.find((candidate) => candidate.move === chosenMove);
  if (chosen === undefined) return undefined;

  const normalized = zeroScores();
  const opportunities = Object.fromEntries(
    BEHAVIOR_DIMENSIONS.map((dimension) => [dimension, false]),
  ) as Record<BehaviorDimension, boolean>;
  for (const dimension of BEHAVIOR_DIMENSIONS) {
    const values = candidates.map((candidate) => candidate.utilities[dimension]);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const spread = maximum - minimum;
    const isOpportunity = candidates.length >= 2 &&
      spread >= MINIMUM_OPPORTUNITY_SPREAD;
    opportunities[dimension] = isOpportunity;
    normalized[dimension] = isOpportunity
      ? rounded(clamp01((chosen.utilities[dimension] - minimum) / spread))
      : NEUTRAL_SCORE;
  }

  return {
    chosen: normalized,
    opportunities,
    decisionDense: BEHAVIOR_DIMENSIONS.some((dimension) =>
      opportunities[dimension]
    ),
    candidateCount: candidates.length,
  };
}

function confidenceFor(opportunities: number): number {
  return rounded(1 - Math.exp(-opportunities / 8));
}

function snapshot(history: Readonly<MutableBehaviorHistory>): BehaviorHistorySnapshot {
  const scores = zeroScores();
  const confidence = {
    ...zeroScores(),
    overall: 0,
  };
  for (const dimension of BEHAVIOR_DIMENSIONS) {
    const count = history.opportunities[dimension];
    scores[dimension] = count === 0
      ? NEUTRAL_SCORE
      : rounded(history.sums[dimension] / count);
    confidence[dimension] = confidenceFor(count);
  }
  confidence.overall = rounded(
    BEHAVIOR_DIMENSIONS.reduce(
      (sum, dimension) => sum + confidence[dimension],
      0,
    ) / BEHAVIOR_DIMENSIONS.length,
  );
  return {
    scores,
    opportunities: { ...history.opportunities },
    confidence,
    decisionsObserved: history.decisionsObserved,
    decisionDenseTurns: history.decisionDenseTurns,
    decisionDensity: rounded(
      history.decisionDenseTurns / Math.max(1, history.decisionsObserved),
    ),
  };
}

/** Incremental, game-local behavior state. It never uses future outcomes. */
export class BehaviorHistoryTracker {
  private readonly histories = new Map<string, MutableBehaviorHistory>();

  current(snakeId: string): BehaviorHistorySnapshot {
    return snapshot(this.mutable(snakeId));
  }

  observe(
    state: Readonly<GameState>,
    snakeId: string,
    move: Direction,
  ): BehaviorDecision | undefined {
    const decision = behaviorDecision(state, snakeId, move);
    if (decision === undefined) return undefined;
    const history = this.mutable(snakeId);
    history.decisionsObserved += 1;
    if (decision.decisionDense) history.decisionDenseTurns += 1;
    for (const dimension of BEHAVIOR_DIMENSIONS) {
      if (!decision.opportunities[dimension]) continue;
      history.opportunities[dimension] += 1;
      history.sums[dimension] += decision.chosen[dimension];
    }
    return decision;
  }

  clear(): void {
    this.histories.clear();
  }

  private mutable(snakeId: string): MutableBehaviorHistory {
    const existing = this.histories.get(snakeId);
    if (existing !== undefined) return existing;
    const created: MutableBehaviorHistory = {
      sums: zeroScores(),
      opportunities: zeroScores(),
      decisionsObserved: 0,
      decisionDenseTurns: 0,
    };
    this.histories.set(snakeId, created);
    return created;
  }
}
