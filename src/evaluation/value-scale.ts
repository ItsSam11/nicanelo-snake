import type { EvaluationFeatures } from "./evaluate-state.js";
import type { EvaluationWeights } from "./weights.js";

/** Constant ongoing-state fields are not evidence of winning. */
export function nonTerminalEvaluationScale(
  weights: Readonly<EvaluationWeights>,
): number {
  return Math.max(
    1,
    Object.entries(weights)
      .filter(([name]) =>
        !name.startsWith("terminal") && name !== "survival"
      )
      .reduce((sum, [, value]) => sum + Math.abs(value), 0),
  );
}

export function ongoingEvaluationScore(
  features: Readonly<EvaluationFeatures>,
  weights: Readonly<EvaluationWeights>,
): number {
  return Object.entries(features).reduce(
    (sum, [name, value]) =>
      name === "survival"
        ? sum
        : sum + value * weights[name as keyof EvaluationFeatures],
    0,
  );
}

/**
 * In a decisive game with N surviving snakes, exactly one of those N snakes
 * can win. This is the neutral log-odds for a survivor before considering the
 * position itself: 25% with four snakes, 33% with three, and 50% in a duel.
 */
export function survivalPhasePriorLogit(aliveSnakeCount: number): number {
  if (!Number.isSafeInteger(aliveSnakeCount) || aliveSnakeCount < 2) {
    throw new Error("alive snake count must be an integer of at least two");
  }
  return -Math.log(aliveSnakeCount - 1);
}

export function valueProbabilityForFeatures(
  features: Readonly<EvaluationFeatures>,
  weights: Readonly<EvaluationWeights>,
  aliveSnakeCount: number,
  residualBias = 0,
): number {
  const logit = survivalPhasePriorLogit(aliveSnakeCount) + residualBias +
    4 * ongoingEvaluationScore(features, weights) /
      nonTerminalEvaluationScale(weights);
  if (logit >= 0) {
    const inverse = Math.exp(-logit);
    return 1 / (1 + inverse);
  }
  const exponential = Math.exp(logit);
  return exponential / (1 + exponential);
}
