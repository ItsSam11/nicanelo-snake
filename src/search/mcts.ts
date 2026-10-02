import { performance } from "node:perf_hooks";
import type {
  Battlesnake,
  Direction,
  GameState,
} from "../api/types.js";
import { DIRECTIONS } from "../domain/board.js";
import { getGameOutcome } from "../domain/game-over.js";
import { sampleStandardFoodSpawn } from "../domain/food-spawn.js";
import type { SnakeMoves } from "../domain/legal-moves.js";
import { simulateTurn } from "../domain/simulate-turn.js";
import { evaluateMove, evaluateState } from "../evaluation/evaluate-state.js";
import {
  nonTerminalEvaluationScale,
  ongoingEvaluationScore,
  survivalPhasePriorLogit,
} from "../evaluation/value-scale.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "../evaluation/weights.js";
import {
  DIRECTION_PRIORITY,
  physicallyViableMoves,
} from "../strategy/static-policy.js";
import { strategicPosture } from "../strategy/strategic-posture.js";
import {
  opponentMoveDistribution,
  policyPriorMoveDistribution,
  resolveOpponentPolicy,
  sampleOpponentMove,
  type OpponentPolicySettings,
  type OpponentPolicyWeights,
  type RandomSource,
} from "./opponent-policy.js";
import { canonicalStateKey } from "./state-key.js";
import { strategicRootPrior } from "./strategic-root-prior.js";
import {
  immediateHeadToHeadOutcome,
  isReasonableHeadToHeadAlternative,
} from "./head-to-head-guard.js";
import type { BehaviorHistorySnapshot } from "../model/behavior-features.js";

const DEFAULT_TIME_BUDGET_MS = 150;
const DEFAULT_MAX_ITERATIONS = 10_000;
const DEFAULT_TREE_DEPTH = 8;
const DEFAULT_ROLLOUT_DEPTH = 6;
const DEFAULT_PUCT_CONSTANT = 1.25;
const DEFAULT_MIN_ROOT_IMPROVEMENT = 0.05;
const DEFAULT_MAX_GAMES = 128;
const DEFAULT_MAX_CACHE_ENTRIES = 50_000;
const DEFAULT_TREE_REUSE_CONTEXT_DECAY = 0.5;
const DEFAULT_ELIMINATION_PROGRESS_BONUS = 0.12;
const DEFAULT_CHANCE_WIDENING_CONSTANT = 1.25;
const DEFAULT_CHANCE_WIDENING_EXPONENT = 0.5;
const DEFAULT_CHANCE_WIDENING_MIN_OUTCOMES = 2;
const DEFAULT_CHANCE_WIDENING_MAX_OUTCOMES = 8;
export const DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT = 0.35;
export const DEFAULT_RISK_FORCED_LOSS_WEIGHT = 0.4;
const MINIMUM_RISK_VISITS = 4;
const MAXIMUM_INITIATIVE_VARIANCE_RELIEF = 0.5;
export const MINIMUM_ROOT_OVERRIDE_VISITS = 32;
export const ROOT_RISK_OVERRIDE_MARGIN = 0.25;
export const ROOT_FORCED_LOSS_OVERRIDE_MARGIN = 0.2;

export type RolloutPolicy = "uniform" | "policy";
export type RootPolicyPrior = Partial<Record<Direction, number>>;

export interface MctsOptions {
  timeBudgetMs?: number;
  maxIterations?: number;
  maxTreeDepth?: number;
  rolloutDepth?: number;
  puctConstant?: number;
  /** Backwards-compatible alias for pre-phase-nine callers. */
  explorationConstant?: number;
  /** Optional ablation gate that lets the static policy veto small MCTS gains. */
  fallbackProtection?: boolean;
  /** Final exact root-safety arbiter. Disable only for paired R7 baselines. */
  rootSafetyArbiter?: boolean;
  /** Conservative low-slack extension evaluated only after hard root safety. */
  rootBranchingReserve?: boolean;
  /** Sample Standard-map food spawns after simulated turns. Defaults to true. */
  simulateFoodSpawns?: boolean;
  minimumRootImprovement?: number;
  /** Rewards removing rivals before the game reaches a terminal state. */
  eliminationProgressBonus?: number;
  /** Controls how quickly stochastic opponent/food outcomes widen per action. */
  chanceWideningConstant?: number;
  chanceWideningExponent?: number;
  chanceWideningMinOutcomes?: number;
  chanceWideningMaxOutcomes?: number;
  /** Bounded downside penalties used by PUCT and final root selection. */
  riskStandardDeviationWeight?: number;
  riskForcedLossWeight?: number;
  /** Learned residual intercept after the per-phase survival prior. */
  valueBias?: number;
  seed?: number;
  now?: () => number;
  opponentPolicy?: {
    temperature?: number;
    weights?: Partial<OpponentPolicyWeights>;
  };
  policyPrior?: {
    temperature?: number;
    weights?: Partial<OpponentPolicyWeights>;
  };
  /** Use the full evaluator to seed our real root. Defaults to true. */
  strategicRootPrior?: boolean;
  /** Internal serializable override calculated once by the worker pool. */
  rootPolicyPrior?: Readonly<RootPolicyPrior>;
  opponentContexts?: Readonly<Record<string, BehaviorHistorySnapshot>>;
  rolloutPolicy?: RolloutPolicy;
  treeReuseContextDecay?: number;
  reuseTreeAcrossOpponentContexts?: boolean;
  /** Internal worker-pool scheduling hint; constrains only the root action. */
  rootMoveConstraint?: Direction;
  /** Number of iterations for which the temporary root constraint applies. */
  rootMoveConstraintIterations?: number;
}

export interface RootMoveStatistics {
  move: Direction;
  visits: number;
  meanValue: number;
  outcomeCount: number;
  prior?: number;
  valueSquareMean?: number;
  downsideSquareMean?: number;
  forcedLossCount?: number;
  valueStandardDeviation?: number;
  downsideDeviation?: number;
  forcedLossRate?: number;
  riskAdjustedValue?: number;
}

export interface MctsResult {
  move: Direction;
  fallbackMove: Direction;
  iterations: number;
  elapsedMs: number;
  deadlineReached: boolean;
  usedSearch: boolean;
  fallbackProtected: boolean;
  rootStatistics: readonly RootMoveStatistics[];
  priorVisits: number;
  reusedTree: boolean;
  cacheHits: number;
  cacheMisses: number;
}

interface ResolvedOptions {
  timeBudgetMs: number;
  maxIterations: number;
  maxTreeDepth: number;
  rolloutDepth: number;
  puctConstant: number;
  fallbackProtection: boolean;
  simulateFoodSpawns: boolean;
  minimumRootImprovement: number;
  eliminationProgressBonus: number;
  chanceWideningConstant: number;
  chanceWideningExponent: number;
  chanceWideningMinOutcomes: number;
  chanceWideningMaxOutcomes: number;
  riskStandardDeviationWeight: number;
  riskForcedLossWeight: number;
  valueBias: number;
  seed: number;
  now: () => number;
  opponentPolicy: Readonly<OpponentPolicySettings>;
  policyPrior: Readonly<OpponentPolicySettings>;
  strategicRootPrior: boolean;
  rootPolicyPrior: Readonly<RootPolicyPrior> | undefined;
  opponentContexts: Readonly<Record<string, BehaviorHistorySnapshot>>;
  rolloutPolicy: RolloutPolicy;
  treeReuseContextDecay: number;
  reuseTreeAcrossOpponentContexts: boolean;
  rootMoveConstraint: Direction | undefined;
  rootMoveConstraintIterations: number;
}

interface DecisionNode {
  state: GameState;
  stateKey: string;
  parentAction: ActionNode | undefined;
  actions: ActionNode[];
  untriedMoves: Direction[];
  movePriors: ReadonlyMap<Direction, number>;
  visits: number;
  valueSum: number;
  depth: number;
  initiative?: number;
}

interface ActionNode {
  parent: DecisionNode;
  move: Direction;
  outcomes: Map<string, DecisionNode>;
  prior: number;
  visits: number;
  valueSum: number;
  valueSquareSum: number;
  downsideSquareSum: number;
  forcedLossCount: number;
}

interface SampledTransition {
  key: string;
  state: GameState;
}

interface StoredGameTree {
  root: DecisionNode;
  nodesByState: Map<string, DecisionNode>;
  configurationKey: string;
  opponentContextKey: string;
  lastAccess: number;
}

interface SearchCacheStatistics {
  hits: number;
  misses: number;
}

export interface MctsMemoryOptions {
  maxGames?: number;
  maxCacheEntries?: number;
}

/** Process-local, disposable search knowledge. Correctness never depends on it. */
export class MctsMemory {
  readonly games = new Map<string, StoredGameTree>();
  readonly moveCache = new Map<string, readonly Direction[]>();
  readonly rewardCache = new Map<string, number>();
  readonly maxGames: number;
  readonly maxCacheEntries: number;

  constructor(options: Readonly<MctsMemoryOptions> = {}) {
    this.maxGames = options.maxGames ?? DEFAULT_MAX_GAMES;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    if (!Number.isInteger(this.maxGames) || this.maxGames < 1) {
      throw new Error("maxGames must be a positive integer");
    }
    if (!Number.isInteger(this.maxCacheEntries) || this.maxCacheEntries < 1) {
      throw new Error("maxCacheEntries must be a positive integer");
    }
  }

  clearGame(gameId: string): void {
    this.games.delete(gameId);
  }

  clear(): void {
    this.games.clear();
    this.moveCache.clear();
    this.rewardCache.clear();
  }
}

function validateFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

function validateInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function configuredRolloutPolicy(): RolloutPolicy {
  const value = process.env.SEARCH_ROLLOUT_POLICY;
  if (value === undefined || value.length === 0) return "policy";
  if (value === "uniform" || value === "policy") return value;
  throw new Error("SEARCH_ROLLOUT_POLICY must be uniform or policy");
}

function configuredContextDecay(): number {
  const value = process.env.SEARCH_TREE_REUSE_CONTEXT_DECAY;
  if (value === undefined || value.length === 0) {
    return DEFAULT_TREE_REUSE_CONTEXT_DECAY;
  }
  return Number(value);
}

function configuredContextReuse(): boolean {
  const value = process.env.SEARCH_REUSE_OPPONENT_CONTEXT_TREE;
  if (value === undefined || value.length === 0) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    "SEARCH_REUSE_OPPONENT_CONTEXT_TREE must be true or false",
  );
}

function configuredFallbackProtection(): boolean {
  const value = process.env.SEARCH_FALLBACK_PROTECTION;
  if (value === undefined || value.length === 0) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("SEARCH_FALLBACK_PROTECTION must be true or false");
}

function configuredStrategicRootPrior(): boolean {
  const value = process.env.SEARCH_STRATEGIC_ROOT_PRIOR;
  if (value === undefined || value.length === 0) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("SEARCH_STRATEGIC_ROOT_PRIOR must be true or false");
}

export function strategicRootPriorEnabled(
  options: Readonly<MctsOptions> = {},
): boolean {
  return options.strategicRootPrior ?? configuredStrategicRootPrior();
}

export function fallbackProtectionEnabled(
  options: Readonly<MctsOptions> = {},
): boolean {
  return options.fallbackProtection ?? configuredFallbackProtection();
}

function configuredFoodSpawnSimulation(): boolean {
  const value = process.env.SEARCH_SIMULATE_FOOD_SPAWNS;
  if (value === undefined || value.length === 0) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("SEARCH_SIMULATE_FOOD_SPAWNS must be true or false");
}

export function foodSpawnSimulationEnabled(
  options: Readonly<MctsOptions> = {},
): boolean {
  return options.simulateFoodSpawns ?? configuredFoodSpawnSimulation();
}

function hashText(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function defaultSearchSeed(state: GameState): number {
  return hashText(`${state.game.id}:${state.turn}:${state.you.id}`);
}

function createRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function defaultSearchBudgetMs(state: GameState): number {
  const configuredBudget = Number.parseInt(
    process.env.SEARCH_TIME_BUDGET_MS ?? "",
    10,
  );
  const configuredReserve = Number.parseInt(
    process.env.SEARCH_RESPONSE_RESERVE_MS ?? "",
    10,
  );
  const maximumBudget =
    Number.isInteger(configuredBudget) && configuredBudget >= 0
      ? configuredBudget
      : DEFAULT_TIME_BUDGET_MS;
  const responseReserve =
    Number.isInteger(configuredReserve) && configuredReserve >= 0
      ? configuredReserve
      : 100;
  const timeout = Number.isFinite(state.game.timeout)
    ? Math.max(0, state.game.timeout)
    : maximumBudget;
  return Math.min(maximumBudget, Math.max(0, timeout - responseReserve));
}

function resolveOptions(
  state: GameState,
  options: Readonly<MctsOptions>,
): ResolvedOptions {
  const timeBudgetMs = options.timeBudgetMs ?? defaultSearchBudgetMs(state);
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTreeDepth = options.maxTreeDepth ?? DEFAULT_TREE_DEPTH;
  const rolloutDepth = options.rolloutDepth ?? DEFAULT_ROLLOUT_DEPTH;
  const puctConstant =
    options.puctConstant ??
    options.explorationConstant ??
    DEFAULT_PUCT_CONSTANT;
  const fallbackProtection = fallbackProtectionEnabled(options);
  const simulateFoodSpawns = foodSpawnSimulationEnabled(options);
  const minimumRootImprovement =
    options.minimumRootImprovement ?? DEFAULT_MIN_ROOT_IMPROVEMENT;
  const eliminationProgressBonus =
    options.eliminationProgressBonus ?? DEFAULT_ELIMINATION_PROGRESS_BONUS;
  const chanceWideningConstant = options.chanceWideningConstant ??
    DEFAULT_CHANCE_WIDENING_CONSTANT;
  const chanceWideningExponent = options.chanceWideningExponent ??
    DEFAULT_CHANCE_WIDENING_EXPONENT;
  const chanceWideningMinOutcomes = options.chanceWideningMinOutcomes ??
    DEFAULT_CHANCE_WIDENING_MIN_OUTCOMES;
  const chanceWideningMaxOutcomes = options.chanceWideningMaxOutcomes ??
    DEFAULT_CHANCE_WIDENING_MAX_OUTCOMES;
  const riskStandardDeviationWeight =
    options.riskStandardDeviationWeight ??
      DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT;
  const riskForcedLossWeight = options.riskForcedLossWeight ??
    DEFAULT_RISK_FORCED_LOSS_WEIGHT;
  const valueBias = options.valueBias ?? 0;
  const seed = options.seed ?? defaultSearchSeed(state);
  const rolloutPolicy = options.rolloutPolicy ?? configuredRolloutPolicy();
  const treeReuseContextDecay = options.treeReuseContextDecay ??
    configuredContextDecay();
  const reuseTreeAcrossOpponentContexts =
    options.reuseTreeAcrossOpponentContexts ?? configuredContextReuse();
  const rootMoveConstraint = options.rootMoveConstraint;
  const rootMoveConstraintIterations =
    options.rootMoveConstraintIterations ?? Number.POSITIVE_INFINITY;

  validateFiniteNonNegative("timeBudgetMs", timeBudgetMs);
  validateInteger("maxIterations", maxIterations);
  validateInteger("maxTreeDepth", maxTreeDepth);
  validateInteger("rolloutDepth", rolloutDepth);
  validateFiniteNonNegative("puctConstant", puctConstant);
  validateFiniteNonNegative(
    "minimumRootImprovement",
    minimumRootImprovement,
  );
  if (
    !Number.isFinite(eliminationProgressBonus) ||
    eliminationProgressBonus < 0 ||
    eliminationProgressBonus > 1
  ) {
    throw new Error("eliminationProgressBonus must be between zero and one");
  }
  if (!Number.isFinite(chanceWideningConstant) || chanceWideningConstant <= 0) {
    throw new Error("chanceWideningConstant must be positive and finite");
  }
  if (
    !Number.isFinite(chanceWideningExponent) ||
    chanceWideningExponent <= 0 ||
    chanceWideningExponent > 1
  ) {
    throw new Error("chanceWideningExponent must be between zero and one");
  }
  validateInteger("chanceWideningMinOutcomes", chanceWideningMinOutcomes);
  validateInteger("chanceWideningMaxOutcomes", chanceWideningMaxOutcomes);
  if (
    chanceWideningMinOutcomes < 1 ||
    chanceWideningMaxOutcomes < chanceWideningMinOutcomes
  ) {
    throw new Error(
      "chance widening outcome limits must be positive and ordered",
    );
  }
  validateFiniteNonNegative(
    "riskStandardDeviationWeight",
    riskStandardDeviationWeight,
  );
  validateFiniteNonNegative("riskForcedLossWeight", riskForcedLossWeight);
  if (!Number.isFinite(valueBias)) {
    throw new Error("valueBias must be finite");
  }
  if (rolloutPolicy !== "uniform" && rolloutPolicy !== "policy") {
    throw new Error("rolloutPolicy must be uniform or policy");
  }
  if (
    !Number.isFinite(treeReuseContextDecay) ||
    treeReuseContextDecay < 0 ||
    treeReuseContextDecay > 1
  ) {
    throw new Error("treeReuseContextDecay must be between zero and one");
  }
  if (!Number.isFinite(seed)) {
    throw new Error("seed must be a finite number");
  }
  if (
    rootMoveConstraint !== undefined &&
    !DIRECTIONS.includes(rootMoveConstraint)
  ) {
    throw new Error("rootMoveConstraint must be a valid direction");
  }
  if (
    options.rootMoveConstraintIterations !== undefined &&
    (!Number.isInteger(rootMoveConstraintIterations) ||
      rootMoveConstraintIterations < 1)
  ) {
    throw new Error("rootMoveConstraintIterations must be a positive integer");
  }
  if (options.rootPolicyPrior !== undefined) {
    for (const [move, value] of Object.entries(options.rootPolicyPrior)) {
      if (!DIRECTIONS.includes(move as Direction)) {
        throw new Error(`rootPolicyPrior contains invalid direction ${move}`);
      }
      validateFiniteNonNegative(`rootPolicyPrior.${move}`, value);
    }
  }

  return {
    timeBudgetMs,
    maxIterations,
    maxTreeDepth,
    rolloutDepth,
    puctConstant,
    fallbackProtection,
    simulateFoodSpawns,
    minimumRootImprovement,
    eliminationProgressBonus,
    chanceWideningConstant,
    chanceWideningExponent,
    chanceWideningMinOutcomes,
    chanceWideningMaxOutcomes,
    riskStandardDeviationWeight,
    riskForcedLossWeight,
    valueBias,
    seed,
    now: options.now ?? performance.now.bind(performance),
    opponentPolicy: resolveOpponentPolicy(options.opponentPolicy),
    policyPrior: resolveOpponentPolicy(options.policyPrior),
    strategicRootPrior: strategicRootPriorEnabled(options),
    rootPolicyPrior: options.rootPolicyPrior,
    opponentContexts: options.opponentContexts ?? {},
    rolloutPolicy,
    treeReuseContextDecay,
    reuseTreeAcrossOpponentContexts,
    rootMoveConstraint,
    rootMoveConstraintIterations,
  };
}

function perspectiveState(
  state: GameState,
  snake: Battlesnake,
): GameState {
  return { ...state, you: snake };
}

function cacheGet<Value>(
  cache: Map<string, Value>,
  key: string,
): Value | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function cacheSet<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  maximum: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximum) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function availableMoves(
  state: GameState,
  perspectiveId: string,
  memory: MctsMemory | undefined,
  cacheStatistics: SearchCacheStatistics,
): Direction[] {
  const stateKey = canonicalStateKey(state);
  const cacheKey = `${perspectiveId}|${stateKey}`;
  if (memory !== undefined) {
    const cached = cacheGet(memory.moveCache, cacheKey);
    if (cached !== undefined) {
      cacheStatistics.hits += 1;
      return [...cached];
    }
    cacheStatistics.misses += 1;
  }

  const snake = state.board.snakes.find((item) => item.id === perspectiveId);
  const moves = snake === undefined
    ? []
    : searchActionMoves(perspectiveState(state, snake));
  if (memory !== undefined) {
    cacheSet(memory.moveCache, cacheKey, moves, memory.maxCacheEntries);
  }
  return [...moves];
}

/**
 * A Battlesnake must always return a protocol direction. Search normally avoids
 * guaranteed-fatal actions, but once none survive it must simulate all four so
 * the rules engine produces a terminal loss instead of valuing the stuck state
 * as an ongoing leaf.
 */
export function searchActionMoves(state: GameState): Direction[] {
  const viable = physicallyViableMoves(state);
  return viable.length > 0 ? viable : [...DIRECTIONS];
}

function createDecisionNode(
  state: GameState,
  perspectiveId: string,
  parentAction: ActionNode | undefined,
  depth: number,
  policyPrior: Readonly<OpponentPolicySettings>,
  memory: MctsMemory | undefined,
  cacheStatistics: SearchCacheStatistics,
  rootPriors?: ReadonlyMap<Direction, number>,
): DecisionNode {
  const moves = availableMoves(
    state,
    perspectiveId,
    memory,
    cacheStatistics,
  );
  const priors = rootPriors ??
    policyPriors(state, perspectiveId, moves, policyPrior);
  return {
    state,
    stateKey: canonicalStateKey(state),
    parentAction,
    actions: [],
    untriedMoves: [...moves].sort(
      (a, b) =>
        (priors.get(b) ?? 0) - (priors.get(a) ?? 0) ||
        DIRECTION_PRIORITY[b] - DIRECTION_PRIORITY[a],
    ),
    movePriors: priors,
    visits: 0,
    valueSum: 0,
    depth,
  };
}

function normalizedRootPriors(
  moves: readonly Direction[],
  supplied: Readonly<RootPolicyPrior>,
): ReadonlyMap<Direction, number> {
  const total = moves.reduce(
    (sum, move) => sum + (supplied[move] ?? 0),
    0,
  );
  if (!(total > 0)) {
    throw new Error(
      "rootPolicyPrior must assign positive mass to a root move",
    );
  }
  return new Map(
    moves.map((move) => [move, (supplied[move] ?? 0) / total]),
  );
}

function rootPriorsForSearch(
  state: GameState,
  perspectiveId: string,
  moves: readonly Direction[],
  weights: Readonly<EvaluationWeights>,
  options: Readonly<ResolvedOptions>,
): ReadonlyMap<Direction, number> {
  if (options.rootPolicyPrior !== undefined) {
    return normalizedRootPriors(moves, options.rootPolicyPrior);
  }
  // When every direction is physically fatal there is no strategic signal to
  // extract; retain the lightweight policy merely to order terminal samples.
  if (
    options.strategicRootPrior &&
    physicallyViableMoves(state).length > 0
  ) {
    const result = strategicRootPrior(state, moves, weights);
    return new Map(
      result.candidates.map((candidate) => [
        candidate.move,
        candidate.probability,
      ]),
    );
  }
  return policyPriors(state, perspectiveId, moves, options.policyPrior);
}

function refreshRootPriors(
  root: DecisionNode,
  priors: ReadonlyMap<Direction, number>,
): void {
  root.movePriors = priors;
  for (const action of root.actions) {
    action.prior = priors.get(action.move) ?? 0;
  }
  root.untriedMoves.sort(
    (a, b) =>
      (priors.get(b) ?? 0) - (priors.get(a) ?? 0) ||
      DIRECTION_PRIORITY[b] - DIRECTION_PRIORITY[a],
  );
}

function randomIndex(length: number, random: RandomSource): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

function policyPriors(
  state: GameState,
  perspectiveId: string,
  moves: readonly Direction[],
  settings: Readonly<OpponentPolicySettings>,
): ReadonlyMap<Direction, number> {
  if (moves.length === 0) {
    return new Map();
  }
  const distribution = policyPriorMoveDistribution(
    state,
    perspectiveId,
    settings,
  );
  const allowed = new Set(moves);
  const filtered = distribution.filter((candidate) =>
    allowed.has(candidate.move)
  );
  const total = filtered.reduce(
    (sum, candidate) => sum + candidate.probability,
    0,
  );
  if (!(total > 0)) {
    const uniform = 1 / moves.length;
    return new Map(moves.map((move) => [move, uniform]));
  }
  return new Map(
    filtered.map((candidate) => [
      candidate.move,
      candidate.probability / total,
    ]),
  );
}

export function samplePolicyMove(
  state: GameState,
  perspectiveId: string,
  moves: readonly Direction[],
  settings: Readonly<OpponentPolicySettings>,
  random: RandomSource,
): Direction | undefined {
  if (moves.length === 0) return undefined;
  const priors = policyPriors(state, perspectiveId, moves, settings);
  const target = Math.max(0, Math.min(1 - Number.EPSILON, random()));
  let cumulative = 0;
  for (const move of moves) {
    cumulative += priors.get(move) ?? 0;
    if (target < cumulative) return move;
  }
  return moves.at(-1);
}

function expandAction(
  node: DecisionNode,
  requestedMove?: Direction,
): ActionNode | undefined {
  const index = requestedMove === undefined
    ? 0
    : node.untriedMoves.indexOf(requestedMove);
  if (index < 0) return undefined;
  const [move] = node.untriedMoves.splice(index, 1);
  if (move === undefined) {
    return undefined;
  }

  const action: ActionNode = {
    parent: node,
    move,
    outcomes: new Map(),
    prior: node.movePriors.get(move) ?? 0,
    visits: 0,
    valueSum: 0,
    valueSquareSum: 0,
    downsideSquareSum: 0,
    forcedLossCount: 0,
  };
  node.actions.push(action);
  return action;
}

export function riskAdjustedValue(
  mean: number,
  downsideDeviation: number,
  forcedLossRate: number,
  visits: number,
  standardDeviationWeight = DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT,
  forcedLossWeight = DEFAULT_RISK_FORCED_LOSS_WEIGHT,
): number {
  if (visits < MINIMUM_RISK_VISITS) return mean;
  return Math.max(
    -1,
    Math.min(
      1,
      mean -
        standardDeviationWeight * Math.max(0, downsideDeviation) -
        forcedLossWeight * Math.max(0, Math.min(1, forcedLossRate)),
    ),
  );
}

/**
 * Initiative relaxes only uncertainty/variance aversion. The forced-loss
 * weight intentionally stays fixed: an offensive posture may accept a wider
 * range of non-terminal outcomes, never a larger proven death rate.
 */
export function initiativeRiskWeights(
  initiative: number,
  standardDeviationWeight = DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT,
  forcedLossWeight = DEFAULT_RISK_FORCED_LOSS_WEIGHT,
): {
  standardDeviationWeight: number;
  forcedLossWeight: number;
} {
  const boundedInitiative = Math.max(0, Math.min(1, initiative));
  return {
    standardDeviationWeight: standardDeviationWeight *
      (1 - MAXIMUM_INITIATIVE_VARIANCE_RELIEF * boundedInitiative),
    forcedLossWeight,
  };
}

function nodeInitiative(
  node: DecisionNode,
  perspectiveId: string,
): number {
  if (node.initiative !== undefined) return node.initiative;
  const alive = node.state.board.snakes.some(
    (snake) => snake.id === perspectiveId,
  );
  node.initiative = alive
    ? strategicPosture(node.state, perspectiveId).initiative
    : 0;
  return node.initiative;
}

function actionValueStatistics(
  action: Readonly<ActionNode>,
  standardDeviationWeight: number,
  forcedLossWeight: number,
): {
  mean: number;
  standardDeviation: number;
  downsideDeviation: number;
  forcedLossRate: number;
  riskAdjusted: number;
} {
  const visits = Math.max(1, action.visits);
  const mean = action.valueSum / visits;
  const variance = Math.max(
    0,
    action.valueSquareSum / visits - mean * mean,
  );
  const standardDeviation = Math.sqrt(variance);
  const downsideDeviation = Math.sqrt(
    Math.max(0, action.downsideSquareSum / visits),
  );
  const forcedLossRate = action.forcedLossCount / visits;
  return {
    mean,
    standardDeviation,
    downsideDeviation,
    forcedLossRate,
    riskAdjusted: riskAdjustedValue(
      mean,
      downsideDeviation,
      forcedLossRate,
      action.visits,
      standardDeviationWeight,
      forcedLossWeight,
    ),
  };
}

function selectAction(
  node: DecisionNode,
  perspectiveId: string,
  puctConstant: number,
  riskStandardDeviationWeight: number,
  riskForcedLossWeight: number,
): ActionNode | undefined {
  // Statistics can decay to zero when a tree is re-rooted under a changed
  // opponent context. PUCT's finite prior bonus does not otherwise guarantee
  // that a low-prior action is sampled again, so restore the usual MCTS
  // invariant that every expanded action receives evidence.
  const unvisited = node.actions
    .filter((action) => action.visits === 0)
    .sort((a, b) =>
      b.prior - a.prior ||
      DIRECTION_PRIORITY[b.move] - DIRECTION_PRIORITY[a.move]
    )[0];
  if (unvisited !== undefined) return unvisited;

  const parentScale = Math.sqrt(Math.max(1, node.visits));
  const risk = initiativeRiskWeights(
    nodeInitiative(node, perspectiveId),
    riskStandardDeviationWeight,
    riskForcedLossWeight,
  );

  return [...node.actions].sort((a, b) => {
    const aValue = actionValueStatistics(
      a,
      risk.standardDeviationWeight,
      risk.forcedLossWeight,
    ).riskAdjusted;
    const bValue = actionValueStatistics(
      b,
      risk.standardDeviationWeight,
      risk.forcedLossWeight,
    ).riskAdjusted;
    const aPuct =
      aValue +
      puctConstant * a.prior * parentScale / (1 + a.visits);
    const bPuct =
      bValue +
      puctConstant * b.prior * parentScale / (1 + b.visits);
    return bPuct - aPuct ||
      DIRECTION_PRIORITY[b.move] - DIRECTION_PRIORITY[a.move];
  })[0];
}

function constrainedRootAction(
  root: DecisionNode,
  move: Direction,
): { action: ActionNode; expanded: boolean } | undefined {
  const existing = root.actions.find((action) => action.move === move);
  if (existing !== undefined) {
    return { action: existing, expanded: false };
  }
  const action = expandAction(root, move);
  return action === undefined ? undefined : { action, expanded: true };
}

function sampleJointMoves(
  state: GameState,
  perspectiveId: string,
  ourMove: Direction,
  settings: Readonly<OpponentPolicySettings>,
  contexts: Readonly<Record<string, BehaviorHistorySnapshot>>,
  random: RandomSource,
): SnakeMoves {
  return Object.fromEntries(
    state.board.snakes.map((snake) => {
      if (snake.id === perspectiveId) {
        return [snake.id, ourMove];
      }
      const distribution = opponentMoveDistribution(
        state,
        snake.id,
        settings,
        contexts[snake.id],
      );
      return [snake.id, sampleOpponentMove(distribution, random)];
    }),
  ) as Record<string, Direction>;
}

function sampledOutcomeKey(
  state: GameState,
  moves: SnakeMoves,
  nextState: GameState,
): string {
  const jointAction = state.board.snakes
    .map((snake) => `${snake.id}:${moves[snake.id] ?? "up"}`)
    .join("|");
  const food = [...nextState.board.food]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map(({ x, y }) => `${x},${y}`)
    .join(";");
  return `${jointAction}|food:${food}`;
}

function sampleTransition(
  state: GameState,
  perspectiveId: string,
  move: Direction,
  settings: Readonly<OpponentPolicySettings>,
  contexts: Readonly<Record<string, BehaviorHistorySnapshot>>,
  simulateFoodSpawns: boolean,
  random: RandomSource,
): SampledTransition {
  const moves = sampleJointMoves(
    state,
    perspectiveId,
    move,
    settings,
    contexts,
    random,
  );
  const deterministic = simulateTurn(state, moves).state;
  const nextState = simulateFoodSpawns
    ? sampleStandardFoodSpawn(deterministic, random)
    : deterministic;
  return {
    key: sampledOutcomeKey(state, moves, nextState),
    state: nextState,
  };
}

export function chanceOutcomeLimit(
  visits: number,
  constant = DEFAULT_CHANCE_WIDENING_CONSTANT,
  exponent = DEFAULT_CHANCE_WIDENING_EXPONENT,
  minimum = DEFAULT_CHANCE_WIDENING_MIN_OUTCOMES,
  maximum = DEFAULT_CHANCE_WIDENING_MAX_OUTCOMES,
): number {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      Math.ceil(constant * Math.pow(Math.max(1, visits + 1), exponent)),
    ),
  );
}

function selectChanceOutcome(
  action: ActionNode,
  sampled: Readonly<SampledTransition>,
  options: Readonly<ResolvedOptions>,
  perspectiveId: string,
  policyPrior: Readonly<OpponentPolicySettings>,
  memory: MctsMemory | undefined,
  cacheStatistics: SearchCacheStatistics,
): { outcome: DecisionNode; expanded: boolean } {
  const existing = action.outcomes.get(sampled.key);
  if (existing !== undefined) {
    return { outcome: existing, expanded: false };
  }

  const limit = chanceOutcomeLimit(
    action.visits,
    options.chanceWideningConstant,
    options.chanceWideningExponent,
    options.chanceWideningMinOutcomes,
    options.chanceWideningMaxOutcomes,
  );
  if (action.outcomes.size >= limit) {
    // Progressive widening limits persistent subtrees, not the transition
    // distribution. Evaluate an unseen sampled state through an ephemeral node
    // so rare outcomes are neither inflated nor silently reassigned to one of
    // the retained children. Backpropagation still reaches the parent action.
    return {
      outcome: createDecisionNode(
        sampled.state,
        perspectiveId,
        action,
        action.parent.depth + 1,
        policyPrior,
        memory,
        cacheStatistics,
      ),
      expanded: true,
    };
  }

  const outcome = createDecisionNode(
    sampled.state,
    perspectiveId,
    action,
    action.parent.depth + 1,
    policyPrior,
    memory,
    cacheStatistics,
  );
  action.outcomes.set(sampled.key, outcome);
  return { outcome, expanded: true };
}

/**
 * Convert the evaluator's linear score to the same centered probability scale
 * used by value-model training. The neutral prior is phase-aware: one eventual
 * winner among the snakes that are still alive.
 */
export function centeredValueFromEvaluation(
  score: number,
  scale: number,
  aliveSnakeCount = 2,
  residualBias = 0,
): number {
  if (!Number.isFinite(score)) {
    throw new Error("evaluation score must be finite");
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("evaluation scale must be a finite positive number");
  }
  if (!Number.isFinite(residualBias)) {
    throw new Error("evaluation bias must be finite");
  }
  return Math.tanh(
    (survivalPhasePriorLogit(aliveSnakeCount) + residualBias) / 2 +
      (2 * score) / scale,
  );
}

function evaluationConfigurationKey(
  weights: Readonly<EvaluationWeights>,
): string {
  return JSON.stringify(weights);
}

function treeConfigurationKey(
  weights: Readonly<EvaluationWeights>,
  options: Readonly<ResolvedOptions>,
  startingOpponentCount: number,
): string {
  return JSON.stringify({
    evaluation: weights,
    opponentPolicy: options.opponentPolicy,
    policyPrior: options.policyPrior,
    puctConstant: options.puctConstant,
    simulateFoodSpawns: options.simulateFoodSpawns,
    eliminationProgressBonus: options.eliminationProgressBonus,
    chanceWideningConstant: options.chanceWideningConstant,
    chanceWideningExponent: options.chanceWideningExponent,
    chanceWideningMinOutcomes: options.chanceWideningMinOutcomes,
    chanceWideningMaxOutcomes: options.chanceWideningMaxOutcomes,
    riskStandardDeviationWeight: options.riskStandardDeviationWeight,
    riskForcedLossWeight: options.riskForcedLossWeight,
    valueBias: options.valueBias,
    startingOpponentCount,
    rolloutPolicy: options.rolloutPolicy,
    treeReuseContextDecay: options.treeReuseContextDecay,
    reuseTreeAcrossOpponentContexts:
      options.reuseTreeAcrossOpponentContexts,
    opponentContexts: options.reuseTreeAcrossOpponentContexts
      ? undefined
      : options.opponentContexts,
  });
}

function opponentContextKey(
  contexts: Readonly<Record<string, BehaviorHistorySnapshot>>,
): string {
  return JSON.stringify(contexts);
}

function stateReward(
  state: GameState,
  perspectiveId: string,
  weights: Readonly<EvaluationWeights>,
  scale: number,
  valueBias: number,
  weightKey: string,
  memory: MctsMemory | undefined,
  cacheStatistics: SearchCacheStatistics,
): number {
  const cacheKey = `${weightKey}|${perspectiveId}|${canonicalStateKey(state)}`;
  if (memory !== undefined) {
    const cached = cacheGet(memory.rewardCache, cacheKey);
    if (cached !== undefined) {
      cacheStatistics.hits += 1;
      return cached;
    }
    cacheStatistics.misses += 1;
  }

  const evaluation = evaluateState(state, perspectiveId, weights);
  let reward: number;
  switch (evaluation.outcome) {
    case "win":
      reward = 1;
      break;
    case "loss":
      reward = -1;
      break;
    case "draw":
      reward = 0;
      break;
    case "ongoing":
      // `survival` is constant for every ongoing state, so it is an intercept
      // learned by the old heuristic/value coupling rather than evidence that
      // this particular branch is winning. Removing it prevents the search
      // from treating mere continued existence as a large positive outcome.
      reward = centeredValueFromEvaluation(
        ongoingEvaluationScore(evaluation.features, weights),
        scale,
        state.board.snakes.length,
        valueBias,
      );
      break;
  }

  if (memory !== undefined) {
    cacheSet(
      memory.rewardCache,
      cacheKey,
      reward,
      memory.maxCacheEntries,
    );
  }
  return reward;
}

/**
 * Adds bounded progress credit for non-terminal eliminations. A single removal
 * is worth more when fewer rivals remain, while terminal values stay exact.
 */
export function valueWithEliminationProgress(
  reward: number,
  startingOpponentCount: number,
  remainingOpponentCount: number,
  bonus: number,
): number {
  if (
    reward <= -1 ||
    reward >= 1 ||
    startingOpponentCount <= 0 ||
    remainingOpponentCount >= startingOpponentCount ||
    !(bonus > 0)
  ) {
    return reward;
  }
  const progress = Math.max(
    0,
    Math.min(
      1,
      (startingOpponentCount - remainingOpponentCount) /
        startingOpponentCount,
    ),
  );
  return Math.min(1, reward + bonus * progress * (1 - reward));
}

function rollout(
  initialState: GameState,
  perspectiveId: string,
  depth: number,
  deadline: number,
  now: () => number,
  settings: Readonly<OpponentPolicySettings>,
  policyPrior: Readonly<OpponentPolicySettings>,
  rolloutPolicy: RolloutPolicy,
  contexts: Readonly<Record<string, BehaviorHistorySnapshot>>,
  simulateFoodSpawns: boolean,
  random: RandomSource,
  memory: MctsMemory | undefined,
  cacheStatistics: SearchCacheStatistics,
): GameState {
  let state = initialState;

  for (let step = 0; step < depth; step += 1) {
    if (now() >= deadline || getGameOutcome(state).gameOver) {
      break;
    }

    const moves = availableMoves(
      state,
      perspectiveId,
      memory,
      cacheStatistics,
    );
    if (moves.length === 0) {
      break;
    }
    const move = rolloutPolicy === "policy"
      ? samplePolicyMove(state, perspectiveId, moves, policyPrior, random)
      : moves[randomIndex(moves.length, random)];
    if (move === undefined) {
      break;
    }
    state = sampleTransition(
      state,
      perspectiveId,
      move,
      settings,
      contexts,
      simulateFoodSpawns,
      random,
    ).state;
  }

  return state;
}

function backpropagate(node: DecisionNode, reward: number): void {
  let current: DecisionNode | undefined = node;
  while (current !== undefined) {
    current.visits += 1;
    current.valueSum += reward;

    const action: ActionNode | undefined = current.parentAction;
    if (action === undefined) {
      break;
    }
    action.visits += 1;
    action.valueSum += reward;
    action.valueSquareSum += reward * reward;
    action.downsideSquareSum += Math.pow(Math.min(0, reward), 2);
    action.forcedLossCount += Number(reward <= -1);
    current = action.parent;
  }
}

function rootStatistics(
  root: DecisionNode,
  perspectiveId: string,
  riskStandardDeviationWeight: number,
  riskForcedLossWeight: number,
): RootMoveStatistics[] {
  const risk = initiativeRiskWeights(
    nodeInitiative(root, perspectiveId),
    riskStandardDeviationWeight,
    riskForcedLossWeight,
  );
  return root.actions
    .map((action) => {
      const value = actionValueStatistics(
        action,
        risk.standardDeviationWeight,
        risk.forcedLossWeight,
      );
      return {
        move: action.move,
        visits: action.visits,
        meanValue: value.mean,
        outcomeCount: action.outcomes.size,
        prior: action.prior,
        valueSquareMean:
          action.valueSquareSum / Math.max(1, action.visits),
        downsideSquareMean:
          action.downsideSquareSum / Math.max(1, action.visits),
        forcedLossCount: action.forcedLossCount,
        valueStandardDeviation: value.standardDeviation,
        downsideDeviation: value.downsideDeviation,
        forcedLossRate: value.forcedLossRate,
        riskAdjustedValue: value.riskAdjusted,
      };
    })
    .sort(
      (a, b) =>
        b.visits - a.visits ||
        (b.riskAdjustedValue ?? b.meanValue) -
          (a.riskAdjustedValue ?? a.meanValue) ||
        b.meanValue - a.meanValue ||
        DIRECTION_PRIORITY[b.move] - DIRECTION_PRIORITY[a.move],
    );
}

function rootStatisticValue(statistic: Readonly<RootMoveStatistics>): number {
  return statistic.riskAdjustedValue ?? statistic.meanValue;
}

/**
 * Keeps visit count as the normal MCTS decision, but prevents a prior-driven
 * visit lead from overruling a large, well-sampled downside difference.
 */
function selectRootMoveStatisticByEvidence(
  statistics: readonly Readonly<RootMoveStatistics>[],
): Readonly<RootMoveStatistics> | undefined {
  const visitLeader = [...statistics].sort(
    (a, b) =>
      b.visits - a.visits ||
      rootStatisticValue(b) - rootStatisticValue(a) ||
      b.meanValue - a.meanValue ||
      DIRECTION_PRIORITY[b.move] - DIRECTION_PRIORITY[a.move],
  )[0];
  if (visitLeader === undefined) return undefined;

  const evidenceLeader = [...statistics]
    .filter((statistic) =>
      statistic.visits >= MINIMUM_ROOT_OVERRIDE_VISITS
    )
    .sort(
      (a, b) =>
        rootStatisticValue(b) - rootStatisticValue(a) ||
        b.visits - a.visits ||
        DIRECTION_PRIORITY[b.move] - DIRECTION_PRIORITY[a.move],
    )[0];
  if (
    evidenceLeader !== undefined &&
    evidenceLeader.move !== visitLeader.move &&
    rootStatisticValue(evidenceLeader) - rootStatisticValue(visitLeader) >=
      ROOT_RISK_OVERRIDE_MARGIN &&
    (visitLeader.forcedLossRate ?? 0) -
        (evidenceLeader.forcedLossRate ?? 0) >=
      ROOT_FORCED_LOSS_OVERRIDE_MARGIN
  ) {
    return evidenceLeader;
  }
  return visitLeader;
}

/**
 * Applies the normal visit/evidence selection, then rejects a root action that
 * can lose an immediate head-to-head when a non-losing move with real escape
 * space was also searched. Winning contests remain eligible.
 */
export function selectRootMoveStatistic(
  statistics: readonly Readonly<RootMoveStatistics>[],
  state?: GameState,
): Readonly<RootMoveStatistics> | undefined {
  const resourceEligible = state === undefined
    ? statistics
    : (() => {
      const evaluated = statistics.map((statistic) => ({
        statistic,
        evaluation: evaluateMove(state, statistic.move),
      }));
      const hasSafeFoodRoute = evaluated.some(({ evaluation }) =>
        evaluation.features.survival > 0 &&
        evaluation.features.trapSafety > -1 &&
        evaluation.tacticalIntent.resourceRequired &&
        evaluation.tacticalIntent.resourceGate
      );
      if (!hasSafeFoodRoute) return statistics;

      const eligible = evaluated.filter(({ statistic, evaluation }) => {
        if (evaluation.tacticalIntent.resourceGate) return true;
        // A fully observed forced win is better than eating. This narrow
        // exception keeps the resource gate from making the snake tactically
        // blind while still rejecting ordinary prior-led food abandonment.
        return statistic.outcomeCount >= 2 && statistic.meanValue >= 1 &&
          (statistic.downsideDeviation ?? 0) === 0 &&
          (statistic.forcedLossRate ?? 0) === 0;
      }).map(({ statistic }) => statistic);
      return eligible.length > 0 ? eligible : statistics;
    })();
  const selected = selectRootMoveStatisticByEvidence(resourceEligible);
  if (
    selected === undefined ||
    state === undefined ||
    immediateHeadToHeadOutcome(state, selected.move) !== "losing"
  ) {
    return selected;
  }

  const alternatives = resourceEligible.filter((statistic) =>
    isReasonableHeadToHeadAlternative(state, statistic.move)
  );
  return selectRootMoveStatisticByEvidence(alternatives) ?? selected;
}

function rebaseTree(node: DecisionNode, depth: number): void {
  node.depth = depth;
  for (const action of node.actions) {
    action.parent = node;
    for (const outcome of action.outcomes.values()) {
      outcome.parentAction = action;
      rebaseTree(outcome, depth + 1);
    }
  }
}

function indexTree(root: DecisionNode): Map<string, DecisionNode> {
  const nodes = new Map<string, DecisionNode>();
  const visit = (node: DecisionNode): void => {
    const previous = nodes.get(node.stateKey);
    if (previous === undefined || node.visits > previous.visits) {
      nodes.set(node.stateKey, node);
    }
    for (const action of node.actions) {
      for (const outcome of action.outcomes.values()) {
        visit(outcome);
      }
    }
  };
  visit(root);
  return nodes;
}

function storeTree(
  memory: MctsMemory,
  gameId: string,
  root: DecisionNode,
  configurationKey: string,
  contextKey: string,
): void {
  memory.games.delete(gameId);
  memory.games.set(gameId, {
    root,
    nodesByState: indexTree(root),
    configurationKey,
    opponentContextKey: contextKey,
    lastAccess: Date.now(),
  });
  while (memory.games.size > memory.maxGames) {
    const oldest = memory.games.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    memory.games.delete(oldest);
  }
}

function decayTreeStatistics(node: DecisionNode, factor: number): void {
  const nodeVisits = Math.floor(node.visits * factor);
  node.valueSum = node.visits === 0
    ? 0
    : (node.valueSum / node.visits) * nodeVisits;
  node.visits = nodeVisits;
  for (const action of node.actions) {
    const actionVisits = Math.floor(action.visits * factor);
    action.valueSum = action.visits === 0
      ? 0
      : (action.valueSum / action.visits) * actionVisits;
    action.valueSquareSum = action.visits === 0
      ? 0
      : (action.valueSquareSum / action.visits) * actionVisits;
    action.downsideSquareSum = action.visits === 0
      ? 0
      : (action.downsideSquareSum / action.visits) * actionVisits;
    action.forcedLossCount = action.visits === 0
      ? 0
      : Math.round(
        (action.forcedLossCount / action.visits) * actionVisits,
      );
    action.visits = actionVisits;
    for (const outcome of action.outcomes.values()) {
      decayTreeStatistics(outcome, factor);
    }
  }
}

function acquireRoot(
  state: GameState,
  perspectiveId: string,
  configurationKey: string,
  contextKey: string,
  contextDecay: number,
  policyPrior: Readonly<OpponentPolicySettings>,
  rootPriors: ReadonlyMap<Direction, number>,
  memory: MctsMemory | undefined,
  cacheStatistics: SearchCacheStatistics,
): { root: DecisionNode; reusedTree: boolean } {
  if (memory !== undefined) {
    const stored = memory.games.get(state.game.id);
    const stateKey = canonicalStateKey(state);
    const reusable = stored?.configurationKey === configurationKey
      ? stored.nodesByState.get(stateKey)
      : undefined;
    if (reusable !== undefined) {
      if (stored?.opponentContextKey !== contextKey) {
        decayTreeStatistics(reusable, contextDecay);
      }
      reusable.state = state;
      reusable.stateKey = stateKey;
      reusable.parentAction = undefined;
      delete reusable.initiative;
      refreshRootPriors(reusable, rootPriors);
      rebaseTree(reusable, 0);
      storeTree(memory, state.game.id, reusable, configurationKey, contextKey);
      return { root: reusable, reusedTree: true };
    }
  }

  const root = createDecisionNode(
    state,
    perspectiveId,
    undefined,
    0,
    policyPrior,
    memory,
    cacheStatistics,
    rootPriors,
  );
  if (memory !== undefined) {
    storeTree(memory, state.game.id, root, configurationKey, contextKey);
  }
  return { root, reusedTree: false };
}

export function searchMove(
  state: GameState,
  fallbackMove: Direction,
  weights: Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
  options: Readonly<MctsOptions> = {},
  memory?: MctsMemory,
): MctsResult {
  const resolved = resolveOptions(state, options);
  const startedAt = resolved.now();
  const deadline = startedAt + resolved.timeBudgetMs;
  const perspectiveId = state.you.id;
  const cacheStatistics: SearchCacheStatistics = { hits: 0, misses: 0 };

  if (
    state.game.ruleset.name !== "standard" ||
    getGameOutcome(state).gameOver ||
    resolved.timeBudgetMs === 0 ||
    resolved.maxIterations === 0
  ) {
    const finishedAt = resolved.now();
    return {
      move: fallbackMove,
      fallbackMove,
      iterations: 0,
      elapsedMs: Math.max(0, finishedAt - startedAt),
      deadlineReached: finishedAt >= deadline,
      usedSearch: false,
      fallbackProtected: false,
      rootStatistics: [],
      priorVisits: 0,
      reusedTree: false,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  const startingOpponentCount = Math.max(0, state.board.snakes.length - 1);
  const rootMoves = searchActionMoves(state);
  const rootPriors = rootPriorsForSearch(
    state,
    perspectiveId,
    rootMoves,
    weights,
    resolved,
  );
  const configurationKey = treeConfigurationKey(
    weights,
    resolved,
    startingOpponentCount,
  );
  const contextKey = opponentContextKey(resolved.opponentContexts);
  const acquired = acquireRoot(
    state,
    perspectiveId,
    configurationKey,
    contextKey,
    resolved.treeReuseContextDecay,
    resolved.policyPrior,
    rootPriors,
    memory,
    cacheStatistics,
  );
  const root = acquired.root;
  const priorVisits = root.visits;
  const random = createRandom(resolved.seed);
  const rewardScale = nonTerminalEvaluationScale(weights);
  const weightKey = `${evaluationConfigurationKey(weights)}|${resolved.valueBias}`;
  let iterations = 0;

  while (
    iterations < resolved.maxIterations &&
    resolved.now() < deadline
  ) {
    let node = root;

    while (
      node.depth < resolved.maxTreeDepth &&
      !getGameOutcome(node.state).gameOver &&
      resolved.now() < deadline
    ) {
      const constrained = node === root &&
          resolved.rootMoveConstraint !== undefined &&
          iterations < resolved.rootMoveConstraintIterations
        ? constrainedRootAction(root, resolved.rootMoveConstraint)
        : undefined;
      const expandedAction = constrained?.expanded ??
        node.untriedMoves.length > 0;
      const action = constrained?.action ??
        (expandedAction
          ? expandAction(node)
        : selectAction(
          node,
          perspectiveId,
          resolved.puctConstant,
            resolved.riskStandardDeviationWeight,
            resolved.riskForcedLossWeight,
          ));
      if (action === undefined) {
        break;
      }

      const sampled = sampleTransition(
        node.state,
        perspectiveId,
        action.move,
        resolved.opponentPolicy,
        resolved.opponentContexts,
        resolved.simulateFoodSpawns,
        random,
      );
      const selectedOutcome = selectChanceOutcome(
        action,
        sampled,
        resolved,
        perspectiveId,
        resolved.policyPrior,
        memory,
        cacheStatistics,
      );
      node = selectedOutcome.outcome;

      // A newly sampled chance outcome is not a strategic expansion by us; if
      // it stopped selection, multiplayer joint moves would consume nearly the
      // whole budget at depth one. Continue through chance states and stop only
      // after adding one of our own decision actions.
      if (expandedAction) {
        break;
      }
    }

    const rolloutState = rollout(
      node.state,
      perspectiveId,
      resolved.rolloutDepth,
      deadline,
      resolved.now,
      resolved.opponentPolicy,
      resolved.policyPrior,
      resolved.rolloutPolicy,
      resolved.opponentContexts,
      resolved.simulateFoodSpawns,
      random,
      memory,
      cacheStatistics,
    );
    const baseReward = stateReward(
      rolloutState,
      perspectiveId,
      weights,
      rewardScale,
      resolved.valueBias,
      weightKey,
      memory,
      cacheStatistics,
    );
    const perspectiveAlive = rolloutState.board.snakes.some(
      (snake) => snake.id === perspectiveId,
    );
    const remainingOpponentCount = rolloutState.board.snakes.reduce(
      (count, snake) => count + Number(snake.id !== perspectiveId),
      0,
    );
    const reward = perspectiveAlive
      ? valueWithEliminationProgress(
        baseReward,
        startingOpponentCount,
        remainingOpponentCount,
        resolved.eliminationProgressBonus,
      )
      : baseReward;
    backpropagate(node, reward);
    iterations += 1;
  }

  if (memory !== undefined) {
    storeTree(memory, state.game.id, root, configurationKey, contextKey);
  }

  const statistics = rootStatistics(
    root,
    perspectiveId,
    resolved.riskStandardDeviationWeight,
    resolved.riskForcedLossWeight,
  );
  const everyRootMoveVisited =
    root.untriedMoves.length === 0 &&
    root.actions.every((action) => action.visits > 0);
  const searchedBest = selectRootMoveStatistic(statistics, state);
  const fallbackStatistics = statistics.find(
    (item) => item.move === fallbackMove,
  );
  const searchAccepted =
    everyRootMoveVisited &&
    searchedBest !== undefined &&
    (!resolved.fallbackProtection ||
      searchedBest.move === fallbackMove ||
      (fallbackStatistics !== undefined &&
        (searchedBest.riskAdjustedValue ?? searchedBest.meanValue) -
            (fallbackStatistics.riskAdjustedValue ??
              fallbackStatistics.meanValue) >=
          resolved.minimumRootImprovement));
  const move = searchAccepted ? searchedBest.move : fallbackMove;
  const finishedAt = resolved.now();

  return {
    move,
    fallbackMove,
    iterations,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    deadlineReached: finishedAt >= deadline,
    usedSearch: everyRootMoveVisited && searchedBest !== undefined,
    fallbackProtected:
      resolved.fallbackProtection &&
      everyRootMoveVisited &&
      searchedBest !== undefined &&
      searchedBest.move !== fallbackMove &&
      !searchAccepted,
    rootStatistics: statistics,
    priorVisits,
    reusedTree: acquired.reusedTree,
    cacheHits: cacheStatistics.hits,
    cacheMisses: cacheStatistics.misses,
  };
}
