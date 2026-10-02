import type { GameState } from "../api/types.js";
import {
  BEHAVIOR_DIMENSIONS,
  BehaviorHistoryTracker,
  type BehaviorConfidence,
  type BehaviorHistorySnapshot,
  type BehaviorOpportunityCounts,
  type BehaviorScores,
} from "../model/behavior-features.js";
import type { OfficialReplay } from "./replay-corpus.js";

export const BEHAVIOR_PROFILE_VERSION = "behavior-profile-v2" as const;

export const BEHAVIOR_PROFILE_NAMES = [
  "aggression",
  "resource-acquisition",
  "health-management",
  "conservatism",
] as const;

export type BehaviorProfileName = typeof BEHAVIOR_PROFILE_NAMES[number];

export interface BehaviorObservation {
  turn: number;
  snakeId: string;
  move: "up" | "down" | "left" | "right";
}

export interface BehaviorProfileMetrics {
  turnsObserved: number;
  observedMoves: number;
  foodEaten: number;
  initialLength: number;
  maximumLength: number;
  averageHealth: number;
  lowHealthRate: number;
  criticalHealthRate: number;
  averageHealthBeforeEating: number | null;
  lastSeenTurn: number;
  decisionDensity: number;
}

export interface SnakeBehaviorProfile {
  profileVersion: typeof BEHAVIOR_PROFILE_VERSION;
  snakeId: string;
  snakeName: string;
  dominantProfile: BehaviorProfileName;
  scores: BehaviorScores;
  opportunities: BehaviorOpportunityCounts;
  confidence: BehaviorConfidence;
  metrics: BehaviorProfileMetrics;
}

export interface BehaviorAnalysis {
  profiles: readonly SnakeBehaviorProfile[];
  historyBeforeMove: ReadonlyMap<string, BehaviorHistorySnapshot>;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function behaviorHistoryKey(turn: number, snakeId: string): string {
  return `${turn}|${snakeId}`;
}

function profileName(dimension: typeof BEHAVIOR_DIMENSIONS[number]): BehaviorProfileName {
  switch (dimension) {
    case "aggression":
      return "aggression";
    case "resourceAcquisition":
      return "resource-acquisition";
    case "healthManagement":
      return "health-management";
    case "conservatism":
      return "conservatism";
  }
}

function dominantProfile(scores: Readonly<BehaviorScores>): BehaviorProfileName {
  return profileName(
    BEHAVIOR_DIMENSIONS.reduce((best, dimension) =>
      scores[dimension] > scores[best] ? dimension : best
    ),
  );
}

function appearances(
  states: readonly GameState[],
  snakeId: string,
): Array<{ state: GameState; health: number; length: number }> {
  return states.flatMap((state) => {
    const snake = state.board.snakes.find((item) => item.id === snakeId);
    return snake === undefined
      ? []
      : [{ state, health: snake.health, length: snake.length }];
  });
}

function profileMetrics(
  replay: Readonly<OfficialReplay>,
  snakeId: string,
  observations: readonly BehaviorObservation[],
  history: Readonly<BehaviorHistorySnapshot>,
): BehaviorProfileMetrics {
  const initialSnake = replay.states[0]?.board.snakes.find((item) =>
    item.id === snakeId
  );
  const seen = appearances(replay.states, snakeId);
  const health = seen.map((item) => item.health);
  const healthBeforeEating: number[] = [];
  let foodEaten = 0;
  for (let index = 0; index + 1 < replay.states.length; index += 1) {
    const before = replay.states[index];
    const after = replay.states[index + 1];
    if (
      before === undefined || after === undefined ||
      after.turn !== before.turn + 1
    ) continue;
    const beforeSnake = before.board.snakes.find((item) => item.id === snakeId);
    const afterSnake = after.board.snakes.find((item) => item.id === snakeId);
    if (beforeSnake === undefined || afterSnake === undefined) continue;
    const lengthGain = Math.max(0, afterSnake.length - beforeSnake.length);
    foodEaten += lengthGain;
    for (let item = 0; item < lengthGain; item += 1) {
      healthBeforeEating.push(beforeSnake.health);
    }
  }
  const averageHealth = health.reduce((sum, value) => sum + value, 0) /
    Math.max(1, health.length);
  return {
    turnsObserved: seen.length,
    observedMoves: observations.filter((item) => item.snakeId === snakeId).length,
    foodEaten,
    initialLength: initialSnake?.length ?? 0,
    maximumLength: Math.max(initialSnake?.length ?? 0, ...seen.map((item) => item.length)),
    averageHealth: rounded(averageHealth),
    lowHealthRate: rounded(
      health.filter((value) => value <= 30).length / Math.max(1, health.length),
    ),
    criticalHealthRate: rounded(
      health.filter((value) => value <= 15).length / Math.max(1, health.length),
    ),
    averageHealthBeforeEating: healthBeforeEating.length === 0
      ? null
      : rounded(
        healthBeforeEating.reduce((sum, value) => sum + value, 0) /
          healthBeforeEating.length,
      ),
    lastSeenTurn: seen.at(-1)?.state.turn ?? replay.states[0]?.turn ?? 0,
    decisionDensity: history.decisionDensity,
  };
}

/**
 * Builds opportunity-conditioned profiles and causal history snapshots. A
 * snapshot for turn T contains decisions observed strictly before turn T.
 * Outcomes are intentionally absent from the behavioral representation.
 */
export function analyzeBehavior(
  replay: Readonly<OfficialReplay>,
  observations: readonly BehaviorObservation[],
): BehaviorAnalysis {
  const initial = replay.states[0];
  if (initial === undefined) {
    return { profiles: [], historyBeforeMove: new Map() };
  }
  const states = new Map(replay.states.map((state) => [state.turn, state]));
  const tracker = new BehaviorHistoryTracker();
  const historyBeforeMove = new Map<string, BehaviorHistorySnapshot>();
  const ordered = [...observations].sort(
    (a, b) => a.turn - b.turn || a.snakeId.localeCompare(b.snakeId),
  );
  for (const observation of ordered) {
    const state = states.get(observation.turn);
    if (state === undefined) continue;
    historyBeforeMove.set(
      behaviorHistoryKey(observation.turn, observation.snakeId),
      tracker.current(observation.snakeId),
    );
    tracker.observe(state, observation.snakeId, observation.move);
  }

  const profiles = initial.board.snakes.map((snake): SnakeBehaviorProfile => {
    const history = tracker.current(snake.id);
    return {
      profileVersion: BEHAVIOR_PROFILE_VERSION,
      snakeId: snake.id,
      snakeName: snake.name,
      dominantProfile: dominantProfile(history.scores),
      scores: history.scores,
      opportunities: history.opportunities,
      confidence: history.confidence,
      metrics: profileMetrics(replay, snake.id, observations, history),
    };
  });
  return { profiles, historyBeforeMove };
}
