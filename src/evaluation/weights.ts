export interface EvaluationWeights {
  terminalWin: number;
  terminalLoss: number;
  terminalDraw: number;
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

export const DEFAULT_EVALUATION_WEIGHTS: Readonly<EvaluationWeights> =
  Object.freeze({
    terminalWin: 1_000_000,
    terminalLoss: -1_000_000,
    terminalDraw: 0,
    survival: 200,
    reachableSpace: 40,
    relativeSpace: 45,
    territory: 30,
    health: 12,
    foodAccess: 50,
    lengthAdvantage: 35,
    mobility: 30,
    headToHead: 40,
    opponentPressure: 18,
    hazardDistance: 12,
    wallDistance: 5,
    tailAccess: 10,
    trapSafety: 55,
  });

type LearnedWeightName = Exclude<keyof EvaluationWeights,
  "terminalWin" | "terminalLoss" | "terminalDraw">;

export const SAFETY_WEIGHT_NAMES = [
  "reachableSpace",
  "relativeSpace",
  "mobility",
  "tailAccess",
  "trapSafety",
] as const satisfies readonly LearnedWeightName[];

/**
 * Individual lower bounds already prevent safety signals from being inverted.
 * Keep a substantial aggregate reserve without forcing every learned model
 * back to the conservative hand-tuned allocation.
 */
export const MINIMUM_SAFETY_WEIGHT_BUDGET_RATIO = 0.75;

export const MINIMUM_SAFETY_WEIGHT_BUDGET = SAFETY_WEIGHT_NAMES.reduce(
  (sum, name) => sum + DEFAULT_EVALUATION_WEIGHTS[name],
  0,
) * MINIMUM_SAFETY_WEIGHT_BUDGET_RATIO;

export interface EvaluationWeightBounds {
  minimum: number;
  maximum: number;
}

function relativeBounds(
  name: LearnedWeightName,
  minimumFactor = 0.5,
  maximumFactor = 2,
): EvaluationWeightBounds {
  const baseline = DEFAULT_EVALUATION_WEIGHTS[name];
  return {
    minimum: baseline * minimumFactor,
    maximum: baseline * maximumFactor,
  };
}

/**
 * Learned weights control live decisions, so predictive correlations cannot be
 * allowed to invert safety semantics. Length is intentionally capped at its
 * hand-tuned value: useful local size advantages may be learned, but global
 * growth can never dominate space, mobility, health, or escape access.
 */
export const LEARNED_EVALUATION_WEIGHT_BOUNDS: Readonly<
  Record<LearnedWeightName, EvaluationWeightBounds>
> = Object.freeze({
  survival: relativeBounds("survival"),
  reachableSpace: relativeBounds("reachableSpace"),
  relativeSpace: relativeBounds("relativeSpace"),
  // These bounded signals describe strategic control rather than generic risk
  // appetite, so they need enough range to affect the learned value materially.
  territory: relativeBounds("territory", 0.5, 3),
  health: relativeBounds("health"),
  foodAccess: relativeBounds("foodAccess"),
  lengthAdvantage: {
    minimum: 0,
    maximum: DEFAULT_EVALUATION_WEIGHTS.lengthAdvantage,
  },
  mobility: relativeBounds("mobility"),
  headToHead: relativeBounds("headToHead", 0.5, 2.5),
  opponentPressure: relativeBounds("opponentPressure", 0.5, 4),
  hazardDistance: relativeBounds("hazardDistance"),
  wallDistance: relativeBounds("wallDistance"),
  tailAccess: relativeBounds("tailAccess"),
  trapSafety: relativeBounds("trapSafety"),
});

export function constrainLearnedEvaluationWeights(
  weights: Readonly<EvaluationWeights>,
): EvaluationWeights {
  const constrained = { ...DEFAULT_EVALUATION_WEIGHTS };
  for (const [name, bounds] of Object.entries(
    LEARNED_EVALUATION_WEIGHT_BOUNDS,
  ) as [LearnedWeightName, EvaluationWeightBounds][]) {
    constrained[name] = Math.max(
      bounds.minimum,
      Math.min(bounds.maximum, weights[name]),
    );
  }
  const safetyTotal = SAFETY_WEIGHT_NAMES.reduce(
    (sum, name) => sum + constrained[name],
    0,
  );
  const deficit = MINIMUM_SAFETY_WEIGHT_BUDGET - safetyTotal;
  if (deficit > 1e-9) {
    const headroom = SAFETY_WEIGHT_NAMES.reduce(
      (sum, name) =>
        sum + Math.max(0, DEFAULT_EVALUATION_WEIGHTS[name] - constrained[name]),
      0,
    );
    if (headroom > 0) {
      for (const name of SAFETY_WEIGHT_NAMES) {
        const gap = Math.max(
          0,
          DEFAULT_EVALUATION_WEIGHTS[name] - constrained[name],
        );
        constrained[name] += deficit * gap / headroom;
      }
    }
  }
  return constrained;
}

export function unsafeLearnedEvaluationWeights(
  weights: Readonly<EvaluationWeights>,
): string[] {
  const unsafe: string[] = [];
  for (const terminal of [
    "terminalWin",
    "terminalLoss",
    "terminalDraw",
  ] as const) {
    if (weights[terminal] !== DEFAULT_EVALUATION_WEIGHTS[terminal]) {
      unsafe.push(terminal);
    }
  }
  for (const [name, bounds] of Object.entries(
    LEARNED_EVALUATION_WEIGHT_BOUNDS,
  ) as [LearnedWeightName, EvaluationWeightBounds][]) {
    const value = weights[name];
    if (value < bounds.minimum || value > bounds.maximum) {
      unsafe.push(name);
    }
  }
  const safetyTotal = SAFETY_WEIGHT_NAMES.reduce(
    (sum, name) => sum + weights[name],
    0,
  );
  if (safetyTotal + 1e-9 < MINIMUM_SAFETY_WEIGHT_BUDGET) {
    unsafe.push("safetyBudget");
  }
  return unsafe;
}

export function resolveEvaluationWeights(
  overrides: Partial<EvaluationWeights> = {},
): EvaluationWeights {
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Evaluation weight ${name} must be a finite number`);
    }
  }

  return { ...DEFAULT_EVALUATION_WEIGHTS, ...overrides };
}
