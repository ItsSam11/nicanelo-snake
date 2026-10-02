import { createHash } from "node:crypto";
import type { Direction, GameState } from "../api/types.js";
import { STRATEGY_FEATURE_SET_VERSION } from "../model/feature-set.js";
import {
  evaluateState,
  type EvaluationFeatures,
} from "../evaluation/evaluate-state.js";
import {
  constrainLearnedEvaluationWeights,
  DEFAULT_EVALUATION_WEIGHTS,
  unsafeLearnedEvaluationWeights,
  type EvaluationWeights,
} from "../evaluation/weights.js";
import {
  nonTerminalEvaluationScale,
  survivalPhasePriorLogit,
} from "../evaluation/value-scale.js";
import {
  parseStrategyModel,
  STRATEGY_MODEL_SCHEMA_VERSION,
  type ModelMetrics,
  type StrategyModelArtifact,
} from "../model/strategy-model.js";
import {
  DEFAULT_OPPONENT_POLICY,
  opponentMoveDistribution,
  policyPriorMoveDistribution,
  type OpponentMoveFeatures,
  type OpponentPolicySettings,
} from "../search/opponent-policy.js";
import { canonicalStateKey } from "../search/state-key.js";
import type { LoadedTrainingGame } from "./corpus-manifest.js";
import { buildReplayCorpus, type OfficialReplay } from "./replay-corpus.js";

export const POLICY_FEATURE_NAMES = [
  "mobility",
  "foodAccess",
  "headSafety",
  "hazardSafety",
  "wallDistance",
  "contextualAggression",
  "contextualResourceAcquisition",
  "contextualHealthManagement",
  "contextualConservatism",
] as const satisfies readonly (keyof OpponentMoveFeatures)[];

export const VALUE_FEATURE_NAMES = [
  "survival",
  "reachableSpace",
  "relativeSpace",
  "territory",
  "health",
  "foodAccess",
  "lengthAdvantage",
  "mobility",
  "headToHead",
  "opponentPressure",
  "hazardDistance",
  "wallDistance",
  "tailAccess",
  "trapSafety",
] as const satisfies readonly (keyof EvaluationFeatures)[];

/** A value model worse than an uninformative binary forecast is not deployable. */
export const MAXIMUM_VALUE_BRIER = 0.25;

export interface PolicyCandidate {
  move: Direction;
  features: readonly number[];
}

export interface PolicySample {
  candidates: readonly PolicyCandidate[];
  targetProbabilities: readonly number[];
  weight: number;
}

export interface ValueSample {
  features: readonly number[];
  phasePriorLogit: number;
  target: number;
  weight: number;
}

export interface GameSamples {
  gameId: string;
  policyPrior: readonly PolicySample[];
  opponentPolicy: readonly PolicySample[];
  value: readonly ValueSample[];
}

export type ModelTrainingGame = OfficialReplay | LoadedTrainingGame;

export interface ModelTrainingOptions {
  modelVersion: string;
  createdAt?: string;
  epochs?: number;
  policyLearningRate?: number;
  valueLearningRate?: number;
  regularization?: number;
  minimumGames?: number;
  puctConstant?: number;
}

interface ResolvedTrainingOptions {
  modelVersion: string;
  createdAt: string;
  epochs: number;
  policyLearningRate: number;
  valueLearningRate: number;
  regularization: number;
  minimumGames: number;
  puctConstant: number;
}

function finitePositive(value: number, description: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${description} must be positive and finite`);
  }
  return value;
}

function resolveOptions(
  options: Readonly<ModelTrainingOptions>,
): ResolvedTrainingOptions {
  if (options.modelVersion.trim().length === 0) {
    throw new Error("modelVersion must be non-empty");
  }
  const epochs = options.epochs ?? 200;
  const minimumGames = options.minimumGames ?? 20;
  if (!Number.isSafeInteger(epochs) || epochs < 1) {
    throw new Error("epochs must be a positive integer");
  }
  if (!Number.isSafeInteger(minimumGames) || minimumGames < 2) {
    throw new Error("minimumGames must be an integer of at least two");
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("createdAt must be an ISO timestamp");
  }
  const regularization = options.regularization ?? 0.02;
  if (!Number.isFinite(regularization) || regularization < 0) {
    throw new Error("regularization must be finite and non-negative");
  }
  return {
    modelVersion: options.modelVersion,
    createdAt,
    epochs,
    minimumGames,
    regularization,
    policyLearningRate: finitePositive(
      options.policyLearningRate ?? 0.12,
      "policyLearningRate",
    ),
    valueLearningRate: finitePositive(
      options.valueLearningRate ?? 0.08,
      "valueLearningRate",
    ),
    puctConstant: finitePositive(
      options.puctConstant ?? 1.25,
      "puctConstant",
    ),
  };
}

function vector<Features extends object>(
  features: Readonly<Features>,
  names: readonly (keyof Features)[],
): number[] {
  return names.map((name) => Number(features[name]));
}

function observationKey(turn: number, snakeId: string): string {
  return `${turn}|${snakeId}`;
}

function perspectiveState(state: GameState, snakeId: string): GameState {
  const snake = state.board.snakes.find((item) => item.id === snakeId);
  if (snake === undefined) {
    throw new Error(`Missing snake ${snakeId} in turn ${state.turn}`);
  }
  return { ...state, you: snake };
}

function normalizedTrainingGame(
  input: Readonly<ModelTrainingGame>,
): LoadedTrainingGame {
  if ("replay" in input) {
    if (!Number.isFinite(input.samplingWeight) || input.samplingWeight <= 0) {
      throw new Error("samplingWeight must be positive and finite");
    }
    return {
      replay: input.replay,
      summary: input.summary,
      samplingWeight: input.samplingWeight,
      searchTargets: input.searchTargets,
    };
  }
  return {
    replay: input,
    summary: buildReplayCorpus(input).summary,
    samplingWeight: 1,
    searchTargets: [],
  };
}

function oneHot(length: number, actualIndex: number): number[] {
  return Array.from({ length }, (_, index) => Number(index === actualIndex));
}

export function trainingSamplesForGame(
  input: Readonly<ModelTrainingGame>,
): GameSamples {
  const { replay, samplingWeight, searchTargets } = normalizedTrainingGame(input);
  const corpus = buildReplayCorpus(replay);
  const observations = new Map(
    corpus.observations.map((item) => [
      observationKey(item.turn, item.snakeId),
      item,
    ]),
  );
  const policyPrior: PolicySample[] = [];
  const opponentPolicy: PolicySample[] = [];
  const value: ValueSample[] = [];
  const initialControlledSnake = replay.states[0]?.you.id;
  const controlledSnakeIds = searchTargets.length === 0
    ? new Set(initialControlledSnake === undefined ? [] : [initialControlledSnake])
    : new Set(searchTargets.map((target) => target.snakeId));
  const eligibleTargets = new Map<string, typeof searchTargets[number]>();
  for (const target of searchTargets) {
    if (!target.policyEligible) continue;
    const key = observationKey(target.turn, target.snakeId);
    if (eligibleTargets.has(key)) {
      throw new Error(
        `Duplicate eligible PUCT target for ${replay.metadata.id} ${key}`,
      );
    }
    eligibleTargets.set(key, target);
  }
  const usedTargets = new Set<string>();

  for (const state of replay.states) {
    for (const snake of state.board.snakes) {
      const perspective = perspectiveState(state, snake.id);
      const evaluation = evaluateState(perspective, snake.id);
      if (evaluation.outcome === "ongoing") {
        value.push({
          features: vector(evaluation.features, VALUE_FEATURE_NAMES),
          phasePriorLogit: survivalPhasePriorLogit(
            state.board.snakes.length,
          ),
          target: replay.result.isDraw
            ? 0.5
            : Number(replay.result.winnerId === snake.id),
          weight: samplingWeight,
        });
      }

      const key = observationKey(state.turn, snake.id);
      const observation = observations.get(key);
      if (controlledSnakeIds.has(snake.id)) {
        const searchTarget = eligibleTargets.get(key);
        if (searchTarget !== undefined) {
          const distribution = policyPriorMoveDistribution(
            perspective,
            snake.id,
            DEFAULT_OPPONENT_POLICY,
          );
          if (searchTarget.stateKey !== canonicalStateKey(perspective)) {
            throw new Error(
              `PUCT target state mismatch for ${replay.metadata.id} ${key}`,
            );
          }
          const targetProbabilities = distribution.map((candidate) =>
            searchTarget.actions.find((action) => action.move === candidate.move)
              ?.probability ?? 0
          );
          const probabilityMass = targetProbabilities.reduce(
            (sum, probability) => sum + probability,
            0,
          );
          if (Math.abs(probabilityMass - 1) > 1e-9) {
            throw new Error(
              `PUCT target actions do not match legal moves for ${replay.metadata.id} ${key}`,
            );
          }
          policyPrior.push({
            candidates: distribution.map((candidate) => ({
              move: candidate.move,
              features: vector(candidate.features, POLICY_FEATURE_NAMES),
            })),
            targetProbabilities,
            weight: samplingWeight,
          });
          usedTargets.add(key);
        }
        continue;
      }

      if (observation === undefined) continue;
      const distribution = opponentMoveDistribution(
        perspective,
        snake.id,
        DEFAULT_OPPONENT_POLICY,
        observation.behaviorBeforeMove,
      );
      const actualIndex = distribution.findIndex(
        (candidate) => candidate.move === observation.move,
      );
      if (actualIndex < 0) continue;
      opponentPolicy.push({
        candidates: distribution.map((candidate) => ({
          move: candidate.move,
          features: vector(candidate.features, POLICY_FEATURE_NAMES),
        })),
        targetProbabilities: oneHot(distribution.length, actualIndex),
        weight: samplingWeight,
      });
    }
  }

  for (const key of eligibleTargets.keys()) {
    if (!usedTargets.has(key)) {
      throw new Error(
        `Eligible PUCT target has no matching replay state for ${replay.metadata.id} ${key}`,
      );
    }
  }

  return { gameId: replay.metadata.id, policyPrior, opponentPolicy, value };
}

function softmax(
  candidates: readonly PolicyCandidate[],
  weights: readonly number[],
  temperature: number,
): number[] {
  const scores = candidates.map((candidate) =>
    candidate.features.reduce(
      (sum, feature, index) => sum + feature * (weights[index] ?? 0),
      0,
    ) / temperature
  );
  const maximum = Math.max(...scores);
  const exponentials = scores.map((score) => Math.exp(score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function policyVector(settings: Readonly<OpponentPolicySettings>): number[] {
  return POLICY_FEATURE_NAMES.map((name) => settings.weights[name]);
}

function policySettings(
  weights: readonly number[],
  temperature: number,
): OpponentPolicySettings {
  return {
    temperature,
    weights: Object.fromEntries(
      POLICY_FEATURE_NAMES.map((name, index) => [name, weights[index] ?? 0]),
    ) as unknown as OpponentPolicySettings["weights"],
  };
}

function trainPolicy(
  samples: readonly PolicySample[],
  initial: Readonly<OpponentPolicySettings>,
  epochs: number,
  learningRate: number,
  regularization: number,
): OpponentPolicySettings {
  const anchor = policyVector(initial);
  const weights = [...anchor];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = weights.map(() => 0);
    let totalWeight = 0;
    for (const sample of samples) {
      const sampleWeight = sample.weight;
      const probabilities = softmax(
        sample.candidates,
        weights,
        initial.temperature,
      );
      for (let candidateIndex = 0;
        candidateIndex < sample.candidates.length;
        candidateIndex += 1) {
        const candidate = sample.candidates[candidateIndex];
        if (candidate === undefined) continue;
        const error = (probabilities[candidateIndex] ?? 0) -
          (sample.targetProbabilities[candidateIndex] ?? 0);
        for (let featureIndex = 0;
          featureIndex < weights.length;
          featureIndex += 1) {
          gradient[featureIndex] = (gradient[featureIndex] ?? 0) +
            sampleWeight * error * (candidate.features[featureIndex] ?? 0) /
              initial.temperature;
        }
      }
      totalWeight += sampleWeight;
    }
    for (let index = 0; index < weights.length; index += 1) {
      const dataGradient = (gradient[index] ?? 0) / Math.max(1, totalWeight);
      const anchorGradient = regularization *
        ((weights[index] ?? 0) - (anchor[index] ?? 0));
      weights[index] = Math.max(
        -20,
        Math.min(
          20,
          (weights[index] ?? 0) - learningRate *
            (dataGradient + anchorGradient),
        ),
      );
    }
  }
  return policySettings(weights, initial.temperature);
}

function nonTerminalScale(weights: Readonly<EvaluationWeights>): number {
  return nonTerminalEvaluationScale(weights);
}

function valueVector(
  weights: Readonly<EvaluationWeights>,
  valueBias = 0,
): number[] {
  const scale = Math.max(1, nonTerminalScale(weights));
  return VALUE_FEATURE_NAMES.map((name) =>
    name === "survival" ? valueBias : 4 * weights[name] / scale
  );
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-value);
    return 1 / (1 + inverse);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function valuePrediction(
  features: readonly number[],
  coefficients: readonly number[],
  phasePriorLogit: number,
): number {
  return sigmoid(
    phasePriorLogit + features.reduce(
      (sum, feature, index) =>
        sum + feature * (coefficients[index] ?? 0),
      0,
    ),
  );
}

function trainValueWeights(
  samples: readonly ValueSample[],
  initial: Readonly<EvaluationWeights>,
  epochs: number,
  learningRate: number,
  regularization: number,
): { evaluationWeights: EvaluationWeights; valueBias: number } {
  const anchor = valueVector(initial);
  const coefficients = [...anchor];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = coefficients.map(() => 0);
    let totalWeight = 0;
    for (const sample of samples) {
      const error = valuePrediction(
        sample.features,
        coefficients,
        sample.phasePriorLogit,
      ) - sample.target;
      for (let index = 0; index < coefficients.length; index += 1) {
        gradient[index] = (gradient[index] ?? 0) +
          sample.weight * error * (sample.features[index] ?? 0);
      }
      totalWeight += sample.weight;
    }
    for (let index = 0; index < coefficients.length; index += 1) {
      const dataGradient = (gradient[index] ?? 0) /
        Math.max(1, totalWeight);
      const anchorGradient = regularization *
        ((coefficients[index] ?? 0) - (anchor[index] ?? 0));
      coefficients[index] = Math.max(
        -6,
        Math.min(
          6,
          (coefficients[index] ?? 0) - learningRate *
            (dataGradient + anchorGradient),
        ),
      );
    }
  }

  const scale = Math.max(1, nonTerminalScale(initial));
  const learned = Object.fromEntries(
    VALUE_FEATURE_NAMES.map((name, index) => [
      name,
      name === "survival"
        ? initial.survival
        : (coefficients[index] ?? 0) * scale / 4,
    ]),
  ) as unknown as Pick<EvaluationWeights, typeof VALUE_FEATURE_NAMES[number]>;
  return {
    evaluationWeights: constrainLearnedEvaluationWeights({
      ...initial,
      ...learned,
    }),
    valueBias: coefficients[VALUE_FEATURE_NAMES.indexOf("survival")] ?? 0,
  };
}

function policyMetrics(
  samples: readonly PolicySample[],
  policy: Readonly<OpponentPolicySettings>,
): Pick<ModelMetrics, "policyNll" | "policyAccuracy"> & { policyBrier: number } {
  const policyWeights = policyVector(policy);
  let policyNll = 0;
  let policyBrier = 0;
  let correct = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const probabilities = softmax(
      sample.candidates,
      policyWeights,
      policy.temperature,
    );
    policyNll -= sample.weight * sample.targetProbabilities.reduce(
      (sum, target, index) =>
        sum + target * Math.log(Math.max(1e-12, probabilities[index] ?? 0)),
      0,
    );
    policyBrier += sample.weight * probabilities.reduce(
      (sum, probability, index) => {
        const error = probability - (sample.targetProbabilities[index] ?? 0);
        return sum + error * error;
      },
      0,
    );
    const predicted = probabilities.reduce(
      (best, probability, index) =>
        probability > (probabilities[best] ?? -1) ? index : best,
      0,
    );
    const target = sample.targetProbabilities.reduce(
      (best, probability, index) =>
        probability > (sample.targetProbabilities[best] ?? -1) ? index : best,
      0,
    );
    correct += sample.weight * Number(predicted === target);
    totalWeight += sample.weight;
  }

  return {
    policyNll: policyNll / Math.max(1, totalWeight),
    policyAccuracy: correct / Math.max(1, totalWeight),
    policyBrier: policyBrier / Math.max(1, totalWeight),
  };
}

function modelMetrics(
  policyPriorSamples: readonly PolicySample[],
  opponentPolicySamples: readonly PolicySample[],
  valueSamples: readonly ValueSample[],
  policyPrior: Readonly<OpponentPolicySettings>,
  opponentPolicy: Readonly<OpponentPolicySettings>,
  evaluationWeights: Readonly<EvaluationWeights>,
  valueBias = 0,
  phasePriorOnly = false,
): ModelMetrics {
  const prior = policyMetrics(policyPriorSamples, policyPrior);
  const opponent = policyMetrics(
    opponentPolicySamples,
    opponentPolicy,
  );

  const coefficients = phasePriorOnly
    ? VALUE_FEATURE_NAMES.map(() => 0)
    : valueVector(evaluationWeights, valueBias);
  const totalValueWeight = valueSamples.reduce(
    (sum, sample) => sum + sample.weight,
    0,
  );
  const valueBrier = valueSamples.reduce((sum, sample) => {
    const error = valuePrediction(
      sample.features,
      coefficients,
      sample.phasePriorLogit,
    ) - sample.target;
    return sum + sample.weight * error * error;
  }, 0) / Math.max(1, totalValueWeight);

  return {
    ...prior,
    opponentPolicyNll: opponent.policyNll,
    opponentPolicyAccuracy: opponent.policyAccuracy,
    opponentPolicyBrier: opponent.policyBrier,
    valueBrier,
  };
}

function corpusDigest(inputs: readonly ModelTrainingGame[]): string {
  const hash = createHash("sha256");
  for (const game of inputs.map(normalizedTrainingGame).sort((a, b) =>
    a.replay.metadata.id.localeCompare(b.replay.metadata.id)
  )) {
    hash.update(JSON.stringify({
      replay: game.replay,
      samplingWeight: game.samplingWeight,
      searchTargets: game.searchTargets,
    }));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function modelOfflineGate(
  baseline: Readonly<ModelMetrics>,
  candidate: Readonly<ModelMetrics>,
  evaluationWeights?: Readonly<EvaluationWeights>,
): boolean {
  const policyTolerance = Math.max(0.005, baseline.policyNll * 0.01);
  const valueTolerance = 0.005;
  const opponentImproved =
    baseline.opponentPolicyNll !== undefined &&
    candidate.opponentPolicyNll !== undefined &&
    candidate.opponentPolicyNll < baseline.opponentPolicyNll - 1e-6;
  const opponentCalibrationPreserved =
    baseline.opponentPolicyBrier === undefined ||
    candidate.opponentPolicyBrier === undefined ||
    candidate.opponentPolicyBrier <= baseline.opponentPolicyBrier + 0.01;
  const noMaterialRegression =
    candidate.policyNll <= baseline.policyNll + policyTolerance &&
    candidate.valueBrier <= baseline.valueBrier + valueTolerance &&
    candidate.valueBrier <= MAXIMUM_VALUE_BRIER;
  return noMaterialRegression && opponentImproved &&
    opponentCalibrationPreserved &&
    (evaluationWeights === undefined ||
      unsafeLearnedEvaluationWeights(evaluationWeights).length === 0);
}

export function validationBucket(gameId: string): number {
  return createHash("sha256").update(gameId).digest()[0]! % 5;
}

/** Trains only from complete games and keeps whole games out of validation. */
export function trainStrategyModel(
  inputs: readonly ModelTrainingGame[],
  options: Readonly<ModelTrainingOptions>,
): StrategyModelArtifact {
  const resolved = resolveOptions(options);
  if (inputs.length < resolved.minimumGames) {
    throw new Error(
      `Need at least ${resolved.minimumGames} complete games; received ${inputs.length}`,
    );
  }
  const games = inputs.map(trainingSamplesForGame).sort((a, b) =>
    a.gameId.localeCompare(b.gameId)
  );
  const naturalValidation = games.filter((game) =>
    validationBucket(game.gameId) === 0
  );
  const validationSelection = naturalValidation.length === 0
    ? [games.at(-1)!]
    : naturalValidation.length === games.length
    ? [games.at(-1)!]
    : naturalValidation;
  const validationGames = new Set(
    validationSelection.map((game) => game.gameId),
  );
  const training = games.filter((game) => !validationGames.has(game.gameId));
  const validation = games.filter((game) => validationGames.has(game.gameId));
  const trainingPolicyPrior = training.flatMap((game) => game.policyPrior);
  const trainingOpponentPolicy = training.flatMap(
    (game) => game.opponentPolicy,
  );
  const trainingValue = training.flatMap((game) => game.value);
  const validationPolicyPrior = validation.flatMap(
    (game) => game.policyPrior,
  );
  const validationOpponentPolicy = validation.flatMap(
    (game) => game.opponentPolicy,
  );
  const validationValue = validation.flatMap((game) => game.value);
  if (
    trainingOpponentPolicy.length === 0 ||
    trainingValue.length === 0 ||
    validationOpponentPolicy.length === 0 ||
    validationValue.length === 0
  ) {
    throw new Error(
      "Corpus does not contain enough separate opponent and value samples",
    );
  }

  const opponentPolicy = trainPolicy(
    trainingOpponentPolicy,
    DEFAULT_OPPONENT_POLICY,
    resolved.epochs,
    resolved.policyLearningRate,
    resolved.regularization,
  );
  const policyPrior = trainingPolicyPrior.length === 0
    ? DEFAULT_OPPONENT_POLICY
    : trainPolicy(
      trainingPolicyPrior,
      DEFAULT_OPPONENT_POLICY,
      resolved.epochs,
      resolved.policyLearningRate,
      resolved.regularization,
    );
  const trainedValue = trainValueWeights(
    trainingValue,
    DEFAULT_EVALUATION_WEIGHTS,
    resolved.epochs,
    resolved.valueLearningRate,
    resolved.regularization,
  );
  const { evaluationWeights, valueBias } = trainedValue;
  const baselineValidation = modelMetrics(
    validationPolicyPrior,
    validationOpponentPolicy,
    validationValue,
    DEFAULT_OPPONENT_POLICY,
    DEFAULT_OPPONENT_POLICY,
    DEFAULT_EVALUATION_WEIGHTS,
    0,
    true,
  );
  const candidateValidation = modelMetrics(
    validationPolicyPrior,
    validationOpponentPolicy,
    validationValue,
    policyPrior,
    opponentPolicy,
    evaluationWeights,
    valueBias,
  );

  return parseStrategyModel({
    schemaVersion: STRATEGY_MODEL_SCHEMA_VERSION,
    modelVersion: resolved.modelVersion,
    createdAt: resolved.createdAt,
    evaluationWeights,
    policyPrior,
    opponentPolicy,
    search: { puctConstant: resolved.puctConstant, valueBias },
    training: {
      method: "softmax-gradient",
      featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
      corpusDigest: corpusDigest(inputs),
      corpusGames: inputs.length,
      trainingSamples: trainingPolicyPrior.length +
        trainingOpponentPolicy.length + trainingValue.length,
      validationSamples: validationPolicyPrior.length +
        validationOpponentPolicy.length + validationValue.length,
      policyPriorTrainingSamples: trainingPolicyPrior.length,
      opponentPolicyTrainingSamples: trainingOpponentPolicy.length,
      valueTrainingSamples: trainingValue.length,
      policyPriorValidationSamples: validationPolicyPrior.length,
      opponentPolicyValidationSamples: validationOpponentPolicy.length,
      valueValidationSamples: validationValue.length,
      epochs: resolved.epochs,
      validationSplit: "game-hash-v2",
      baselineValidation,
      candidateValidation,
      offlineGatePassed: modelOfflineGate(
        baselineValidation,
        candidateValidation,
        evaluationWeights,
      ),
    },
  });
}
