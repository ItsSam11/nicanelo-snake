import type { Direction, GameState } from "../api/types.js";
import {
  evaluateMove,
  type EvaluationFeatures,
} from "../evaluation/evaluate-state.js";
import type { TacticalIntent } from "../evaluation/offense.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "../evaluation/weights.js";
import {
  strategicPosture,
  type StrategicPosture,
} from "../strategy/strategic-posture.js";

export interface StrategicRootPriorWeights {
  trapSafety: number;
  mobility: number;
  territory: number;
  opponentPressure: number;
  headToHead: number;
  foodAccess: number;
}

export interface StrategicRootPriorOptions {
  temperature?: number;
  weights?: Partial<StrategicRootPriorWeights>;
  /** Applied only when at least one alternative avoids unanimous catastrophe. */
  catastrophicPenalty?: number;
  /** Applied only when another safe move preserves a critical food route. */
  resourceGatePenalty?: number;
}

export interface StrategicRootPriorCandidate {
  move: Direction;
  probability: number;
  score: number;
  catastrophic: boolean;
  resourceBlocked: boolean;
  features: Readonly<EvaluationFeatures>;
  tacticalIntent: Readonly<TacticalIntent>;
}

export interface StrategicRootPriorResult {
  posture: Readonly<StrategicPosture>;
  candidates: readonly StrategicRootPriorCandidate[];
}

export const DEFAULT_STRATEGIC_ROOT_PRIOR_WEIGHTS:
  Readonly<StrategicRootPriorWeights> = Object.freeze({
    trapSafety: 1.25,
    mobility: 0.7,
    territory: 0.8,
    opponentPressure: 1,
    headToHead: 0.8,
    foodAccess: 0.85,
  });

const DEFAULT_TEMPERATURE = 0.85;
const DEFAULT_CATASTROPHIC_PENALTY = 6;
// Search must retain enough mass to refute a food plan with a forced win. The
// hard resource veto lives in tactical attack scoring and the deadline-safe
// fallback; this optional prior penalty is kept for controlled ablations.
const DEFAULT_RESOURCE_GATE_PENALTY = 0;

function validateFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function resolvedWeights(
  overrides: Partial<StrategicRootPriorWeights> | undefined,
): StrategicRootPriorWeights {
  const weights = {
    ...DEFAULT_STRATEGIC_ROOT_PRIOR_WEIGHTS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(weights)) {
    validateFinite(`Strategic root prior weight ${name}`, value);
  }
  return weights;
}

function uniqueMoves(moves: readonly Direction[]): Direction[] {
  const result: Direction[] = [];
  const seen = new Set<Direction>();
  for (const move of moves) {
    if (seen.has(move)) {
      throw new Error(`Duplicate strategic root move ${move}`);
    }
    seen.add(move);
    result.push(move);
  }
  return result;
}

function candidateScore(
  features: Readonly<EvaluationFeatures>,
  intent: Readonly<TacticalIntent>,
  posture: Readonly<StrategicPosture>,
  weights: Readonly<StrategicRootPriorWeights>,
  evaluationWeights: Readonly<EvaluationWeights>,
): number {
  const initiative = posture.initiative;

  // The model controls the strategic emphasis while these bounded ratios keep
  // the prior numerically stable. This makes a newly selected value baseline
  // affect both leaf judgment and the root exploration budget without letting
  // one learned coefficient monopolize PUCT before evidence arrives.
  const modelScale = (name: keyof StrategicRootPriorWeights): number => {
    const baseline = DEFAULT_EVALUATION_WEIGHTS[name];
    return Math.max(
      0.5,
      Math.min(2, evaluationWeights[name] / baseline),
    );
  };

  // With reserves, Nicanelo deliberately converts safety capital into
  // territory, pressure, head control, and controlled growth. When reserves
  // disappear the same formula continuously returns weight to escape.
  const trapSafetyWeight = (weights.trapSafety - 0.45 * initiative) *
    modelScale("trapSafety");
  const mobilityWeight = (weights.mobility - 0.2 * initiative) *
    modelScale("mobility");
  const territoryWeight = (weights.territory + 0.9 * initiative) *
    modelScale("territory");
  const pressureWeight = (weights.opponentPressure + 1.8 * initiative) *
    modelScale("opponentPressure");
  const headToHeadWeight = (weights.headToHead + 0.7 * initiative) *
    modelScale("headToHead");
  const foodWeight = (
    weights.foodAccess +
    0.65 * posture.resourceUrgency + 0.35 * initiative
  ) * modelScale("foodAccess");

  const resourcePlanBonus = intent.kind === "RESOURCE_GROWTH" ||
      intent.kind === "RECOVER"
    ? 0.1 * intent.score
    : 0;

  return trapSafetyWeight * features.trapSafety +
    mobilityWeight * features.mobility +
    territoryWeight * features.territory +
    pressureWeight * features.opponentPressure +
    headToHeadWeight * features.headToHead +
    foodWeight * features.foodAccess +
    resourcePlanBonus;
}

/**
 * Produces a serializable policy prior for the real search root. It is kept
 * separate from the opponent model because our strategic policy needs causal
 * offense and territory features that an imitation-oriented opponent policy
 * does not expose.
 *
 * This analysis intentionally calls the full candidate evaluator and is
 * therefore suitable for one root calculation per turn, not every MCTS node.
 */
export function strategicRootPrior(
  state: GameState,
  moves: readonly Direction[],
  evaluationWeights: Readonly<EvaluationWeights> =
    DEFAULT_EVALUATION_WEIGHTS,
  options: Readonly<StrategicRootPriorOptions> = {},
): StrategicRootPriorResult {
  const candidates = uniqueMoves(moves);
  const posture = strategicPosture(state);
  if (candidates.length === 0) {
    return { posture, candidates: [] };
  }

  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error("Strategic root prior temperature must be positive and finite");
  }
  const catastrophicPenalty = options.catastrophicPenalty ??
    DEFAULT_CATASTROPHIC_PENALTY;
  if (!Number.isFinite(catastrophicPenalty) || catastrophicPenalty < 0) {
    throw new Error("Strategic root catastrophic penalty must be finite and non-negative");
  }
  const resourceGatePenalty = options.resourceGatePenalty ??
    DEFAULT_RESOURCE_GATE_PENALTY;
  if (!Number.isFinite(resourceGatePenalty) || resourceGatePenalty < 0) {
    throw new Error("Strategic root resource gate penalty must be finite and non-negative");
  }
  const weights = resolvedWeights(options.weights);
  const evaluated = candidates.map((move) => {
    const evaluation = evaluateMove(state, move, evaluationWeights);
    const features = evaluation.features;
    const catastrophic = features.survival <= 0 || features.trapSafety <= -1;
    return {
      move,
      features,
      tacticalIntent: evaluation.tacticalIntent,
      catastrophic,
      score: candidateScore(
        features,
        evaluation.tacticalIntent,
        posture,
        weights,
        evaluationWeights,
      ),
    };
  });
  const hasNonCatastrophicAlternative = evaluated.some(
    (candidate) => !candidate.catastrophic,
  );
  const hasResourcePreservingAlternative = evaluated.some(
    (candidate) =>
      !candidate.catastrophic && candidate.tacticalIntent.resourceRequired &&
      candidate.tacticalIntent.resourceGate,
  );
  const penalized = evaluated.map((candidate) => ({
    ...candidate,
    resourceBlocked: hasResourcePreservingAlternative &&
      candidate.tacticalIntent.resourceRequired &&
      !candidate.tacticalIntent.resourceGate,
    score: candidate.score - Number(
      hasNonCatastrophicAlternative && candidate.catastrophic,
    ) * catastrophicPenalty - Number(
      hasResourcePreservingAlternative &&
        candidate.tacticalIntent.resourceRequired &&
        !candidate.tacticalIntent.resourceGate,
    ) * resourceGatePenalty,
  }));
  const maximum = Math.max(...penalized.map((candidate) => candidate.score));
  const exponentials = penalized.map((candidate) =>
    Math.exp((candidate.score - maximum) / temperature)
  );
  const total = exponentials.reduce((sum, value) => sum + value, 0);

  return {
    posture,
    candidates: penalized.map((candidate, index) => ({
      ...candidate,
      probability: (exponentials[index] ?? 0) / total,
    })),
  };
}
