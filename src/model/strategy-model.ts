import { readFile } from "node:fs/promises";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  resolveEvaluationWeights,
  unsafeLearnedEvaluationWeights,
  type EvaluationWeights,
} from "../evaluation/weights.js";
import type { MctsOptions } from "../search/mcts.js";
import { STRATEGY_FEATURE_SET_VERSION } from "./feature-set.js";
import {
  resolveOpponentPolicy,
  type OpponentPolicySettings,
} from "../search/opponent-policy.js";

export const STRATEGY_MODEL_SCHEMA_VERSION = 2 as const;

export interface ModelMetrics {
  policyNll: number;
  policyAccuracy: number;
  opponentPolicyNll?: number;
  opponentPolicyAccuracy?: number;
  opponentPolicyBrier?: number;
  valueBrier: number;
}

export interface ModelTrainingMetadata {
  method: "baseline" | "softmax-gradient";
  featureSetVersion?: string;
  corpusDigest: string;
  corpusGames: number;
  trainingSamples: number;
  validationSamples: number;
  policyPriorTrainingSamples?: number;
  opponentPolicyTrainingSamples?: number;
  valueTrainingSamples?: number;
  policyPriorValidationSamples?: number;
  opponentPolicyValidationSamples?: number;
  valueValidationSamples?: number;
  epochs: number;
  validationSplit: "game-hash-v2" | "selection-manifest-v1";
  baselineValidation: ModelMetrics | null;
  candidateValidation: ModelMetrics | null;
  offlineGatePassed: boolean;
}

export interface StrategyModelArtifact {
  schemaVersion: typeof STRATEGY_MODEL_SCHEMA_VERSION;
  modelVersion: string;
  createdAt: string;
  evaluationWeights: EvaluationWeights;
  policyPrior: OpponentPolicySettings;
  opponentPolicy: OpponentPolicySettings;
  search: {
    puctConstant: number;
    valueBias: number;
  };
  training: ModelTrainingMetadata;
}

export type ModelLogger = (
  entry: Readonly<Record<string, unknown>>,
) => void;

function object(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${description} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, description: string): number {
  const parsed = finiteNumber(value, description);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} must be a non-negative integer`);
  }
  return parsed;
}

function metrics(value: unknown, description: string): ModelMetrics | null {
  if (value === null) return null;
  const candidate = object(value, description);
  const policyAccuracy = finiteNumber(
    candidate.policyAccuracy,
    `${description}.policyAccuracy`,
  );
  if (policyAccuracy < 0 || policyAccuracy > 1) {
    throw new Error(`${description}.policyAccuracy must be between 0 and 1`);
  }
  const opponentPolicyNll = candidate.opponentPolicyNll === undefined
    ? undefined
    : finiteNumber(
      candidate.opponentPolicyNll,
      `${description}.opponentPolicyNll`,
    );
  const opponentPolicyAccuracy = candidate.opponentPolicyAccuracy === undefined
    ? undefined
    : finiteNumber(
      candidate.opponentPolicyAccuracy,
      `${description}.opponentPolicyAccuracy`,
    );
  const opponentPolicyBrier = candidate.opponentPolicyBrier === undefined
    ? undefined
    : finiteNumber(
      candidate.opponentPolicyBrier,
      `${description}.opponentPolicyBrier`,
    );
  if (
    opponentPolicyAccuracy !== undefined &&
    (opponentPolicyAccuracy < 0 || opponentPolicyAccuracy > 1)
  ) {
    throw new Error(
      `${description}.opponentPolicyAccuracy must be between 0 and 1`,
    );
  }
  return {
    policyNll: finiteNumber(
      candidate.policyNll,
      `${description}.policyNll`,
    ),
    policyAccuracy,
    ...(opponentPolicyNll === undefined ? {} : { opponentPolicyNll }),
    ...(opponentPolicyAccuracy === undefined
      ? {}
      : { opponentPolicyAccuracy }),
    ...(opponentPolicyBrier === undefined ? {} : { opponentPolicyBrier }),
    valueBrier: finiteNumber(
      candidate.valueBrier,
      `${description}.valueBrier`,
    ),
  };
}

function optionalNonNegativeInteger(
  value: unknown,
  description: string,
): number | undefined {
  return value === undefined
    ? undefined
    : nonNegativeInteger(value, description);
}

function policy(
  value: unknown,
  description: string,
): OpponentPolicySettings {
  const candidate = object(value, description);
  const weights = object(candidate.weights, `${description}.weights`);
  return resolveOpponentPolicy({
    temperature: finiteNumber(
      candidate.temperature,
      `${description}.temperature`,
    ),
    weights: {
      mobility: finiteNumber(
        weights.mobility,
        `${description}.weights.mobility`,
      ),
      foodAccess: finiteNumber(
        weights.foodAccess,
        `${description}.weights.foodAccess`,
      ),
      headSafety: finiteNumber(
        weights.headSafety,
        `${description}.weights.headSafety`,
      ),
      hazardSafety: finiteNumber(
        weights.hazardSafety,
        `${description}.weights.hazardSafety`,
      ),
      wallDistance: finiteNumber(
        weights.wallDistance,
        `${description}.weights.wallDistance`,
      ),
      contextualAggression: finiteNumber(
        weights.contextualAggression,
        `${description}.weights.contextualAggression`,
      ),
      contextualResourceAcquisition: finiteNumber(
        weights.contextualResourceAcquisition,
        `${description}.weights.contextualResourceAcquisition`,
      ),
      contextualHealthManagement: finiteNumber(
        weights.contextualHealthManagement,
        `${description}.weights.contextualHealthManagement`,
      ),
      contextualConservatism: finiteNumber(
        weights.contextualConservatism,
        `${description}.weights.contextualConservatism`,
      ),
    },
  });
}

function trainingMetadata(value: unknown): ModelTrainingMetadata {
  const candidate = object(value, "training metadata");
  if (
    candidate.method !== "baseline" &&
    candidate.method !== "softmax-gradient"
  ) {
    throw new Error("Invalid training method");
  }
  if (typeof candidate.corpusDigest !== "string") {
    throw new Error("training.corpusDigest must be a string");
  }
  if (
    candidate.featureSetVersion !== undefined &&
    (typeof candidate.featureSetVersion !== "string" ||
      candidate.featureSetVersion.trim().length === 0)
  ) {
    throw new Error("training.featureSetVersion must be a non-empty string");
  }
  if (typeof candidate.offlineGatePassed !== "boolean") {
    throw new Error("training.offlineGatePassed must be a boolean");
  }
  if (
    candidate.validationSplit !== "game-hash-v2" &&
    candidate.validationSplit !== "selection-manifest-v1"
  ) {
    throw new Error("training.validationSplit is unsupported");
  }
  const policyPriorTrainingSamples = optionalNonNegativeInteger(
    candidate.policyPriorTrainingSamples,
    "training.policyPriorTrainingSamples",
  );
  const opponentPolicyTrainingSamples = optionalNonNegativeInteger(
    candidate.opponentPolicyTrainingSamples,
    "training.opponentPolicyTrainingSamples",
  );
  const valueTrainingSamples = optionalNonNegativeInteger(
    candidate.valueTrainingSamples,
    "training.valueTrainingSamples",
  );
  const policyPriorValidationSamples = optionalNonNegativeInteger(
    candidate.policyPriorValidationSamples,
    "training.policyPriorValidationSamples",
  );
  const opponentPolicyValidationSamples = optionalNonNegativeInteger(
    candidate.opponentPolicyValidationSamples,
    "training.opponentPolicyValidationSamples",
  );
  const valueValidationSamples = optionalNonNegativeInteger(
    candidate.valueValidationSamples,
    "training.valueValidationSamples",
  );
  return {
    method: candidate.method,
    ...(candidate.featureSetVersion === undefined
      ? {}
      : { featureSetVersion: candidate.featureSetVersion }),
    corpusDigest: candidate.corpusDigest,
    corpusGames: nonNegativeInteger(
      candidate.corpusGames,
      "training.corpusGames",
    ),
    trainingSamples: nonNegativeInteger(
      candidate.trainingSamples,
      "training.trainingSamples",
    ),
    validationSamples: nonNegativeInteger(
      candidate.validationSamples,
      "training.validationSamples",
    ),
    ...(policyPriorTrainingSamples === undefined
      ? {}
      : { policyPriorTrainingSamples }),
    ...(opponentPolicyTrainingSamples === undefined
      ? {}
      : { opponentPolicyTrainingSamples }),
    ...(valueTrainingSamples === undefined ? {} : { valueTrainingSamples }),
    ...(policyPriorValidationSamples === undefined
      ? {}
      : { policyPriorValidationSamples }),
    ...(opponentPolicyValidationSamples === undefined
      ? {}
      : { opponentPolicyValidationSamples }),
    ...(valueValidationSamples === undefined
      ? {}
      : { valueValidationSamples }),
    epochs: nonNegativeInteger(candidate.epochs, "training.epochs"),
    validationSplit: candidate.validationSplit,
    baselineValidation: metrics(
      candidate.baselineValidation,
      "training.baselineValidation",
    ),
    candidateValidation: metrics(
      candidate.candidateValidation,
      "training.candidateValidation",
    ),
    offlineGatePassed: candidate.offlineGatePassed,
  };
}

export const DEFAULT_STRATEGY_MODEL: Readonly<StrategyModelArtifact> =
  Object.freeze<StrategyModelArtifact>({
    schemaVersion: STRATEGY_MODEL_SCHEMA_VERSION,
    modelVersion: "heuristic-adaptive-control-v1",
    createdAt: "2026-09-20T19:00:00.000Z",
    evaluationWeights: {
      ...DEFAULT_EVALUATION_WEIGHTS,
      reachableSpace: 25,
      relativeSpace: 25,
      territory: 75,
      health: 10,
      foodAccess: 55,
      lengthAdvantage: 25,
      mobility: 35,
      headToHead: 90,
      opponentPressure: 54,
      hazardDistance: 10,
      wallDistance: 2.5,
    },
    policyPrior: {
      temperature: 1.1,
      weights: {
        mobility: 1.6,
        foodAccess: 2.6,
        headSafety: 5,
        hazardSafety: 2,
        wallDistance: 0,
        contextualAggression: 1.5,
        contextualResourceAcquisition: 1.1,
        contextualHealthManagement: 0.7,
        contextualConservatism: 1.2,
      },
    },
    opponentPolicy: {
      temperature: 1.15,
      weights: {
        mobility: 2.2,
        foodAccess: 2.5,
        headSafety: 3.5,
        hazardSafety: 1.5,
        wallDistance: 0.5,
        contextualAggression: 0.6,
        contextualResourceAcquisition: 0.5,
        contextualHealthManagement: 0.4,
        contextualConservatism: 0.5,
      },
    },
    search: { puctConstant: 1.15, valueBias: 0 },
    training: {
      method: "baseline",
      featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
      corpusDigest: "hand-tuned-adaptive-control-v1",
      corpusGames: 0,
      trainingSamples: 0,
      validationSamples: 0,
      epochs: 0,
      validationSplit: "game-hash-v2",
      baselineValidation: null,
      candidateValidation: null,
      offlineGatePassed: true,
    },
  });

export function parseStrategyModel(value: unknown): StrategyModelArtifact {
  const candidate = object(value, "strategy model");
  if (candidate.schemaVersion !== STRATEGY_MODEL_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported strategy model schema ${String(candidate.schemaVersion)}`,
    );
  }
  if (
    typeof candidate.modelVersion !== "string" ||
    candidate.modelVersion.trim().length === 0
  ) {
    throw new Error("modelVersion must be a non-empty string");
  }
  if (
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    throw new Error("createdAt must be an ISO timestamp");
  }
  const evaluation = object(
    candidate.evaluationWeights,
    "evaluation weights",
  );
  const resolvedEvaluation = resolveEvaluationWeights(
    Object.fromEntries(
      Object.keys(DEFAULT_EVALUATION_WEIGHTS).map((name) => [
        name,
        finiteNumber(
          evaluation[name],
          `evaluationWeights.${name}`,
        ),
      ]),
    ) as unknown as EvaluationWeights,
  );
  const search = object(candidate.search, "search configuration");
  const puctConstant = finiteNumber(
    search.puctConstant,
    "search.puctConstant",
  );
  if (puctConstant <= 0) {
    throw new Error("search.puctConstant must be positive");
  }
  const valueBias = search.valueBias === undefined
    ? 0
    : finiteNumber(search.valueBias, "search.valueBias");
  const training = trainingMetadata(candidate.training);
  if (
    training.method !== "baseline" &&
    training.featureSetVersion !== STRATEGY_FEATURE_SET_VERSION
  ) {
    throw new Error(
      `Model feature set ${String(training.featureSetVersion)} is incompatible with ${STRATEGY_FEATURE_SET_VERSION}`,
    );
  }
  const unsafeWeights = unsafeLearnedEvaluationWeights(resolvedEvaluation);
  if (unsafeWeights.length > 0) {
    throw new Error(
      `Unsafe learned evaluation weights: ${unsafeWeights.join(", ")}`,
    );
  }

  return {
    schemaVersion: STRATEGY_MODEL_SCHEMA_VERSION,
    modelVersion: candidate.modelVersion,
    createdAt: candidate.createdAt,
    evaluationWeights: resolvedEvaluation,
    policyPrior: policy(candidate.policyPrior, "policyPrior"),
    opponentPolicy: policy(candidate.opponentPolicy, "opponentPolicy"),
    search: { puctConstant, valueBias },
    training,
  };
}

export async function loadStrategyModel(
  path: string,
): Promise<StrategyModelArtifact> {
  const text = await readFile(path, "utf8");
  return parseStrategyModel(JSON.parse(text) as unknown);
}

export async function loadStrategyModelFromEnvironment(
  logger: ModelLogger = (entry) => console.error(JSON.stringify(entry)),
): Promise<StrategyModelArtifact> {
  const path = process.env.MODEL_PATH;
  if (path === undefined || path.length === 0) {
    return parseStrategyModel(DEFAULT_STRATEGY_MODEL);
  }
  try {
    const model = await loadStrategyModel(path);
    if (!model.training.offlineGatePassed) {
      throw new Error(
        `Model ${model.modelVersion} did not pass its offline promotion gate`,
      );
    }
    logger({
      event: "model_loaded",
      modelVersion: model.modelVersion,
      path,
    });
    return model;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown model error";
    logger({
      event: "model_load_error",
      path,
      error: message,
    });
    throw new Error(`Configured strategy model could not be loaded: ${message}`, {
      cause: error,
    });
  }
}

export function modelSearchOptions(
  model: Readonly<StrategyModelArtifact>,
): MctsOptions {
  return {
    puctConstant: model.search.puctConstant,
    valueBias: model.search.valueBias,
    policyPrior: {
      temperature: model.policyPrior.temperature,
      weights: { ...model.policyPrior.weights },
    },
    opponentPolicy: {
      temperature: model.opponentPolicy.temperature,
      weights: { ...model.opponentPolicy.weights },
    },
  };
}
