import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type {
  Direction,
  GameState,
  MoveResponse,
} from "../api/types.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "../evaluation/weights.js";
import {
  defaultSearchBudgetMs,
  defaultSearchSeed,
  DEFAULT_RISK_FORCED_LOSS_WEIGHT,
  DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT,
  fallbackProtectionEnabled,
  foodSpawnSimulationEnabled,
  initiativeRiskWeights,
  searchActionMoves,
  riskAdjustedValue,
  selectRootMoveStatistic,
  strategicRootPriorEnabled,
  type MctsOptions,
  type MctsResult,
  type RootMoveStatistics,
} from "./mcts.js";
import {
  DIRECTION_PRIORITY,
  chooseStaticMove,
  physicallyViableMoves,
  rankStaticMoves,
} from "../strategy/static-policy.js";
import { strategicPosture } from "../strategy/strategic-posture.js";
import { strategicRootPrior } from "./strategic-root-prior.js";
import {
  BehaviorHistoryTracker,
  inferObservedDirection,
  type BehaviorHistorySnapshot,
} from "../model/behavior-features.js";
import type {
  SearchWorkerRequest,
  SearchWorkerResponse,
} from "./search-worker-protocol.js";
import {
  analyzeRootSafety,
  arbitrateRootMove,
  rootBranchingReserveEnabled,
  rootSafetyArbiterEnabled,
  type RootSafetyDecision,
} from "./root-safety-arbiter.js";

interface PendingSearch {
  resolve: (result: MctsResult) => void;
  reject: (error: Error) => void;
}

interface PendingReady {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface WorkerSearchHandle {
  promise: Promise<MctsResult>;
  cancel: () => void;
}

interface SearchStageDeadlines {
  /** Last instant at which a worker may spend CPU on this stage. */
  computeEpochMs: number;
  /** Last instant at which the coordinator will accept a stage result. */
  collectEpochMs: number;
}

const MINIMUM_COORDINATED_BUDGET_MS = 100;
const COVERAGE_BUDGET_FRACTION = 0.28;
const COVERAGE_ITERATION_FRACTION = 0.25;
const MINIMUM_COVERAGE_BUDGET_MS = 24;
const COVERAGE_RESULT_RESERVE_MS = 4;

export interface SearchPoolOptions {
  workerCount?: number;
  dispatchReserveMs?: number;
}

export interface PooledSearchResult extends MctsResult {
  workersRequested: number;
  workersCompleted: number;
  /** Present on the authoritative coordinator result returned to /move. */
  rootSafety?: RootSafetyDecision;
}

function mergePolicyOptions(
  base: MctsOptions["opponentPolicy"],
  override: MctsOptions["opponentPolicy"],
): MctsOptions["opponentPolicy"] {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const temperature = override.temperature ?? base.temperature;
  const weights = base.weights === undefined && override.weights === undefined
    ? undefined
    : { ...base.weights, ...override.weights };
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(weights === undefined ? {} : { weights }),
  };
}

function mergeSearchOptions(
  base: Readonly<MctsOptions>,
  override: Readonly<MctsOptions>,
): MctsOptions {
  const opponentPolicy = mergePolicyOptions(
    base.opponentPolicy,
    override.opponentPolicy,
  );
  const policyPrior = mergePolicyOptions(
    base.policyPrior,
    override.policyPrior,
  );
  return {
    ...base,
    ...override,
    ...(opponentPolicy === undefined ? {} : { opponentPolicy }),
    ...(policyPrior === undefined ? {} : { policyPrior }),
  };
}

function validateWorkerCount(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("workerCount must be a positive integer");
  }
}

function defaultWorkerCount(): number {
  const configured = Number.parseInt(process.env.SEARCH_WORKERS ?? "", 10);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return Math.min(4, Math.max(1, availableParallelism() - 1));
}

function workerSeed(
  baseSeed: number,
  workerIndex: number,
  phase = 0,
): number {
  return (
    (baseSeed >>> 0) +
    Math.imul(workerIndex, 0x9e3779b1) +
    Math.imul(phase, 0x85ebca6b)
  ) >>> 0;
}

function coverageAssignments(
  moves: readonly Direction[],
  workerCount: number,
): Array<Direction | undefined> {
  if (moves.length === 0) return Array.from({ length: workerCount });
  if (moves.length === 3 && workerCount === 4) {
    return [moves[0], moves[1], moves[2], undefined];
  }
  return Array.from(
    { length: workerCount },
    (_, index) => moves[index % moves.length],
  );
}

function focusAssignments(
  moves: readonly Direction[],
  statistics: readonly RootMoveStatistics[],
  workerCount: number,
): Direction[] {
  const observed = new Set(statistics.filter((item) => item.visits > 0).map(
    (item) => item.move,
  ));
  const missing = moves.filter((move) => !observed.has(move));
  const ranked = [...statistics]
    .filter((item) => item.visits > 0)
    .sort(
      (a, b) =>
        (b.riskAdjustedValue ?? b.meanValue) -
          (a.riskAdjustedValue ?? a.meanValue) ||
        b.visits - a.visits ||
        DIRECTION_PRIORITY[b.move] - DIRECTION_PRIORITY[a.move],
    )
    .map((item) => item.move);
  const retainedCount = Math.max(1, Math.ceil(moves.length / 2));
  const retained = ranked.slice(0, retainedCount);
  const pool = [...missing, ...retained];
  const fallbackPool = pool.length > 0 ? pool : [...moves];
  return Array.from(
    { length: workerCount },
    (_, index) => fallbackPool[index % fallbackPool.length] ?? moves[0]!,
  );
}

function confidenceRadius(statistic: Readonly<RootMoveStatistics>): number {
  return 1.96 * Math.max(0.1, statistic.valueStandardDeviation ?? 0.1) /
    Math.sqrt(Math.max(1, statistic.visits));
}

/** Returns true only when coverage already separates one root action cleanly. */
export function rootCoverageConverged(
  selectedMove: Direction,
  moves: readonly Direction[],
  statistics: readonly RootMoveStatistics[],
): boolean {
  const byMove = new Map(statistics.map((item) => [item.move, item]));
  const covered = moves.map((move) => byMove.get(move));
  if (
    covered.some((item) => item === undefined || item.visits < 16) ||
    covered.length < 2
  ) {
    return false;
  }
  const ranked = (covered as RootMoveStatistics[]).sort(
    (a, b) =>
      (b.riskAdjustedValue ?? b.meanValue) -
        (a.riskAdjustedValue ?? a.meanValue),
  );
  const leader = ranked[0];
  if (leader === undefined) return false;
  const leaderValue = leader.riskAdjustedValue ?? leader.meanValue;
  const leaderLower = leaderValue - confidenceRadius(leader);
  const alternatives = ranked.slice(1);
  const separated = alternatives.every((item) =>
    leaderLower >=
      (item.riskAdjustedValue ?? item.meanValue) + confidenceRadius(item) + 0.1
  );
  const allLowLoss = ranked.every((item) => (item.forcedLossRate ?? 0) <= 0.1);
  const lossAdvantage = alternatives.every((item) =>
    (item.forcedLossRate ?? 0) - (leader.forcedLossRate ?? 0) >= 0.1
  );
  return leader.move === selectedMove &&
    separated &&
    (allLowLoss || lossAdvantage);
}

function combineWorkerPhases(
  coverage: Readonly<MctsResult>,
  focused: Readonly<MctsResult>,
): MctsResult {
  return {
    ...focused,
    iterations: coverage.iterations + focused.iterations,
    elapsedMs: coverage.elapsedMs + focused.elapsedMs,
    // Reaching the deliberately short coverage boundary is not the global
    // request deadline.
    deadlineReached: focused.deadlineReached,
    // The focused result already contains cumulative root statistics because
    // the worker reuses its private tree. Do not add coverage visits again.
    rootStatistics: focused.rootStatistics,
    priorVisits: coverage.priorVisits,
    reusedTree: coverage.reusedTree,
    cacheHits: coverage.cacheHits + focused.cacheHits,
    cacheMisses: coverage.cacheMisses + focused.cacheMisses,
  };
}

function emptyPooledResult(
  fallbackMove: Direction,
  workersRequested: number,
): PooledSearchResult {
  return {
    move: fallbackMove,
    fallbackMove,
    iterations: 0,
    elapsedMs: 0,
    deadlineReached: true,
    usedSearch: false,
    fallbackProtected: false,
    rootStatistics: [],
    priorVisits: 0,
    reusedTree: false,
    cacheHits: 0,
    cacheMisses: 0,
    workersRequested,
    workersCompleted: 0,
  };
}

export function aggregateSearchResults(
  state: GameState,
  fallbackMove: Direction,
  results: readonly MctsResult[],
  workersRequested: number,
  minimumRootImprovement: number,
  fallbackProtection = false,
  riskStandardDeviationWeight = DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT,
  riskForcedLossWeight = DEFAULT_RISK_FORCED_LOSS_WEIGHT,
): PooledSearchResult {
  if (results.length === 0) {
    return emptyPooledResult(fallbackMove, workersRequested);
  }

  const perspectiveAlive = state.board.snakes.some(
    (snake) => snake.id === state.you.id,
  );
  const risk = initiativeRiskWeights(
    perspectiveAlive ? strategicPosture(state).initiative : 0,
    riskStandardDeviationWeight,
    riskForcedLossWeight,
  );

  const totals = new Map<
    Direction,
    {
      visits: number;
      valueSum: number;
      outcomeCount: number;
      priorSum: number;
      priorSamples: number;
      valueSquareSum: number;
      downsideSquareSum: number;
      forcedLossCount: number;
    }
  >();
  for (const result of results) {
    for (const statistic of result.rootStatistics) {
      const current = totals.get(statistic.move) ?? {
        visits: 0,
        valueSum: 0,
        outcomeCount: 0,
        priorSum: 0,
        priorSamples: 0,
        valueSquareSum: 0,
        downsideSquareSum: 0,
        forcedLossCount: 0,
      };
      current.visits += statistic.visits;
      current.valueSum += statistic.meanValue * statistic.visits;
      current.outcomeCount += statistic.outcomeCount;
      const squareMean = statistic.valueSquareMean ??
        Math.pow(statistic.valueStandardDeviation ?? 0, 2) +
          statistic.meanValue * statistic.meanValue;
      current.valueSquareSum += squareMean * statistic.visits;
      const downsideSquareMean = statistic.downsideSquareMean ??
        Math.pow(
          statistic.downsideDeviation ??
            statistic.valueStandardDeviation ??
            0,
          2,
        );
      current.downsideSquareSum += downsideSquareMean * statistic.visits;
      current.forcedLossCount +=
        statistic.forcedLossCount ??
          (statistic.forcedLossRate ?? 0) * statistic.visits;
      if (statistic.prior !== undefined) {
        current.priorSum += statistic.prior;
        current.priorSamples += 1;
      }
      totals.set(statistic.move, current);
    }
  }

  const statistics: RootMoveStatistics[] = [...totals.entries()]
    .map(([move, value]) => {
      const visits = Math.max(1, value.visits);
      const meanValue = value.valueSum / visits;
      const valueSquareMean = value.valueSquareSum / visits;
      const valueStandardDeviation = Math.sqrt(
        Math.max(0, valueSquareMean - meanValue * meanValue),
      );
      const downsideSquareMean = value.downsideSquareSum / visits;
      const downsideDeviation = Math.sqrt(
        Math.max(0, downsideSquareMean),
      );
      const forcedLossRate = value.forcedLossCount / visits;
      return {
        move,
        visits: value.visits,
        meanValue,
        outcomeCount: value.outcomeCount,
        valueSquareMean,
        downsideSquareMean,
        forcedLossCount: value.forcedLossCount,
        valueStandardDeviation,
        downsideDeviation,
        forcedLossRate,
        riskAdjustedValue: riskAdjustedValue(
          meanValue,
          downsideDeviation,
          forcedLossRate,
          value.visits,
          risk.standardDeviationWeight,
          risk.forcedLossWeight,
        ),
        ...(value.priorSamples === 0
          ? {}
          : { prior: value.priorSum / value.priorSamples }),
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

  const candidates = searchActionMoves(state);
  const everyRootMoveVisited = candidates.every(
    (move) => (totals.get(move)?.visits ?? 0) > 0,
  );
  const searchedBest = selectRootMoveStatistic(statistics, state);
  const fallbackStatistics = statistics.find(
    (item) => item.move === fallbackMove,
  );
  const searchAccepted =
    everyRootMoveVisited &&
    searchedBest !== undefined &&
    (!fallbackProtection ||
      searchedBest.move === fallbackMove ||
      (fallbackStatistics !== undefined &&
        (searchedBest.riskAdjustedValue ?? searchedBest.meanValue) -
            (fallbackStatistics.riskAdjustedValue ??
              fallbackStatistics.meanValue) >=
          minimumRootImprovement));

  return {
    move: searchAccepted && searchedBest !== undefined
      ? searchedBest.move
      : fallbackMove,
    fallbackMove,
    iterations: results.reduce((sum, result) => sum + result.iterations, 0),
    elapsedMs: Math.max(...results.map((result) => result.elapsedMs)),
    deadlineReached: results.some((result) => result.deadlineReached),
    usedSearch: everyRootMoveVisited && searchedBest !== undefined,
    fallbackProtected:
      fallbackProtection &&
      everyRootMoveVisited &&
      searchedBest !== undefined &&
      searchedBest.move !== fallbackMove &&
      !searchAccepted,
    rootStatistics: statistics,
    priorVisits: results.reduce((sum, result) => sum + result.priorVisits, 0),
    reusedTree: results.some((result) => result.reusedTree),
    cacheHits: results.reduce((sum, result) => sum + result.cacheHits, 0),
    cacheMisses: results.reduce((sum, result) => sum + result.cacheMisses, 0),
    workersRequested,
    workersCompleted: results.length,
  };
}

class SearchWorkerSlot {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, PendingSearch>();
  private readonly readyWaiters = new Set<PendingReady>();
  private nextRequestId = 1;
  private ready = false;
  private closing = false;

  constructor(readonly index: number) {
    this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(new URL("./search-worker.js", import.meta.url));
    this.ready = false;
    worker.on("message", (message: SearchWorkerResponse) => {
      if (message.type === "ready") {
        if (this.worker !== worker) return;
        this.ready = true;
        for (const waiter of this.readyWaiters) {
          waiter.resolve();
        }
        this.readyWaiters.clear();
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.requestId);
      if (message.type === "result") {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
    });
    worker.on("error", (error) => {
      this.ready = false;
      this.rejectPending(error);
      this.rejectReadyWaiters(error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.ready = false;
      }
      const error = new Error(`Search worker exited with code ${code}`);
      this.rejectPending(error);
      this.rejectReadyWaiters(error);
      if (!this.closing) {
        this.spawn();
      }
    });
    this.worker = worker;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  private waitUntilReady(): {
    promise: Promise<void>;
    cancel: (error: Error) => void;
  } {
    if (this.ready) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }

    let waiter: PendingReady | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = {
        resolve: () => resolve(),
        reject,
      };
      this.readyWaiters.add(waiter);
    });
    return {
      promise,
      cancel: (error: Error) => {
        if (waiter !== undefined && this.readyWaiters.delete(waiter)) {
          waiter.reject(error);
        }
      },
    };
  }

  async whenReady(): Promise<void> {
    await this.waitUntilReady().promise;
  }

  search(
    state: GameState,
    fallbackMove: Direction,
    weights: Readonly<EvaluationWeights>,
    options: Readonly<MctsOptions>,
    deadlineEpochMs: number,
  ): WorkerSearchHandle {
    const readiness = this.waitUntilReady();
    const cancellationBuffer = new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT,
    );
    const cancellationFlag = new Int32Array(cancellationBuffer);
    let requestId: number | undefined;
    let settled = false;
    let resolvePromise!: (result: MctsResult) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<MctsResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const resolve = (result: MctsResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    void readiness.promise.then(() => {
      if (settled) return;
      if (Date.now() >= deadlineEpochMs) {
        reject(new Error("Search worker deadline elapsed before dispatch"));
        return;
      }
      const worker = this.worker;
      if (worker === undefined || !this.ready) {
        reject(new Error("Search worker is unavailable"));
        return;
      }

      requestId = this.nextRequestId;
      this.nextRequestId += 1;
      this.pending.set(requestId, { resolve, reject });
      const message: SearchWorkerRequest = {
        type: "search",
        requestId,
        state,
        fallbackMove,
        weights: { ...weights },
        options: { ...options },
        deadlineEpochMs,
        cancellationBuffer,
      };
      worker.postMessage(message);
    }, reject);

    return {
      promise,
      cancel: () => {
        if (settled) return;
        Atomics.store(cancellationFlag, 0, 1);
        const error = new Error("Search worker request timed out");
        readiness.cancel(error);
        if (requestId !== undefined) {
          this.pending.delete(requestId);
        }
        reject(error);
      },
    };
  }

  clearGame(gameId: string): void {
    this.worker?.postMessage({ type: "clear-game", gameId });
  }

  clear(): void {
    this.worker?.postMessage({ type: "clear-all" });
  }

  async close(): Promise<void> {
    this.closing = true;
    const error = new Error("Search worker pool closed");
    this.rejectPending(error);
    this.rejectReadyWaiters(error);
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      await worker.terminate();
    }
  }
}

export class PersistentSearchPool {
  private readonly workers: SearchWorkerSlot[];
  private readonly dispatchReserveMs: number;
  private closed = false;

  constructor(options: Readonly<SearchPoolOptions> = {}) {
    const workerCount = options.workerCount ?? defaultWorkerCount();
    validateWorkerCount(workerCount);
    this.dispatchReserveMs = options.dispatchReserveMs ?? 8;
    if (!Number.isFinite(this.dispatchReserveMs) || this.dispatchReserveMs < 0) {
      throw new Error("dispatchReserveMs must be a finite non-negative number");
    }
    this.workers = Array.from(
      { length: workerCount },
      (_, index) => new SearchWorkerSlot(index),
    );
  }

  get workerCount(): number {
    return this.workers.length;
  }

  async ready(): Promise<void> {
    if (this.closed) {
      throw new Error("Search worker pool is closed");
    }
    await Promise.all(this.workers.map((worker) => worker.whenReady()));
    if (this.closed) {
      throw new Error("Search worker pool is closed");
    }
  }

  private async runStage(
    state: GameState,
    fallbackMove: Direction,
    weights: Readonly<EvaluationWeights>,
    optionsByWorker: readonly Readonly<MctsOptions>[],
    deadlines: Readonly<SearchStageDeadlines>,
  ): Promise<Map<number, MctsResult>> {
    if (deadlines.collectEpochMs < deadlines.computeEpochMs) {
      throw new Error(
        "stage collection deadline cannot precede compute deadline",
      );
    }
    const tasks = this.workers.map((worker, index) => ({
      index,
      handle: worker.search(
        state,
        fallbackMove,
        weights,
        optionsByWorker[index] ?? {},
        deadlines.computeEpochMs,
      ),
    }));
    const completed = new Map<number, MctsResult>();
    let settled = 0;
    await new Promise<void>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        for (const task of tasks) task.handle.cancel();
        finish();
      }, Math.max(0, deadlines.collectEpochMs - Date.now()));

      for (const task of tasks) {
        void task.handle.promise
          .then((result) => completed.set(task.index, result))
          .catch(() => undefined)
          .finally(() => {
            settled += 1;
            if (settled === tasks.length) finish();
          });
      }
    });
    return completed;
  }

  async search(
    state: GameState,
    fallbackMove: Direction,
    weights: Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
    options: Readonly<MctsOptions> = {},
  ): Promise<PooledSearchResult> {
    if (this.closed) {
      return emptyPooledResult(fallbackMove, this.workerCount);
    }

    const totalBudgetMs = options.timeBudgetMs ?? defaultSearchBudgetMs(state);
    if (!Number.isFinite(totalBudgetMs) || totalBudgetMs < 0) {
      throw new Error("timeBudgetMs must be a finite non-negative number");
    }
    if (totalBudgetMs === 0 || options.maxIterations === 0) {
      return emptyPooledResult(fallbackMove, this.workerCount);
    }

    const startedAtEpochMs = Date.now();
    const workerBudgetMs = Math.max(
      0,
      totalBudgetMs - Math.min(this.dispatchReserveMs, totalBudgetMs),
    );
    if (workerBudgetMs === 0) {
      return emptyPooledResult(fallbackMove, this.workerCount);
    }

    const baseSeed = options.seed ?? defaultSearchSeed(state);
    const fallbackProtection = fallbackProtectionEnabled(options);
    const simulateFoodSpawns = foodSpawnSimulationEnabled(options);
    const rootMoves = searchActionMoves(state);
    const rootPriorEnabled = strategicRootPriorEnabled(options);
    const generatedRootPolicyPrior =
      options.rootPolicyPrior === undefined &&
        rootPriorEnabled &&
        physicallyViableMoves(state).length > 0
        ? Object.fromEntries(
          strategicRootPrior(state, rootMoves, weights).candidates.map(
            (candidate) => [candidate.move, candidate.probability],
          ),
        )
        : undefined;
    const { now: ignoredNow, ...serializableOptions } = options;
    void ignoredNow;
    const workerBaseOptions: MctsOptions = {
      ...serializableOptions,
      strategicRootPrior: rootPriorEnabled,
      ...(generatedRootPolicyPrior === undefined
        ? {}
        : { rootPolicyPrior: generatedRootPolicyPrior }),
    };
    const workerDeadlineEpochMs = startedAtEpochMs + workerBudgetMs;
    const responseDeadlineEpochMs = startedAtEpochMs + totalBudgetMs;
    const aggregate = (results: readonly MctsResult[]): PooledSearchResult =>
      aggregateSearchResults(
        state,
        fallbackMove,
        results,
        this.workerCount,
        options.minimumRootImprovement ?? 0.05,
        fallbackProtection,
        options.riskStandardDeviationWeight ??
          DEFAULT_RISK_STANDARD_DEVIATION_WEIGHT,
        options.riskForcedLossWeight ?? DEFAULT_RISK_FORCED_LOSS_WEIGHT,
      );
    const aggregateCoordinated = (
      results: readonly MctsResult[],
    ): PooledSearchResult => ({
      ...aggregate(results),
      // Coverage workers deliberately use a short local deadline. Only expose
      // deadlineReached when the coordinated request consumed its global
      // compute window, not merely the first phase's slice.
      deadlineReached: Date.now() >= workerDeadlineEpochMs,
    });
    const maximumIterations = options.maxIterations;
    const coordinated =
      this.workerCount >= rootMoves.length &&
      this.workerCount > 1 &&
      rootMoves.length > 1 &&
      workerBudgetMs >= MINIMUM_COORDINATED_BUDGET_MS &&
      (maximumIterations === undefined || maximumIterations >= 2);

    if (!coordinated) {
      const completed = await this.runStage(
        state,
        fallbackMove,
        weights,
        this.workers.map((worker) => ({
          ...workerBaseOptions,
          fallbackProtection,
          simulateFoodSpawns,
          timeBudgetMs: workerBudgetMs,
          seed: workerSeed(baseSeed, worker.index),
        })),
        {
          computeEpochMs: workerDeadlineEpochMs,
          collectEpochMs: responseDeadlineEpochMs,
        },
      );
      return aggregate([...completed.values()]);
    }

    const coverageBudgetMs = Math.min(
      workerBudgetMs - 1,
      Math.max(
        MINIMUM_COVERAGE_BUDGET_MS,
        Math.floor(workerBudgetMs * COVERAGE_BUDGET_FRACTION),
      ),
    );
    const coverageDeadlineEpochMs = startedAtEpochMs + coverageBudgetMs;
    const coverageSearchBudgetMs = Math.max(
      1,
      coverageBudgetMs - COVERAGE_RESULT_RESERVE_MS,
    );
    const coverageMaxIterations = maximumIterations === undefined
      ? undefined
      : Math.max(1, Math.floor(
        maximumIterations * COVERAGE_ITERATION_FRACTION,
      ));
    const focusedMaxIterations = maximumIterations === undefined
      ? undefined
      : maximumIterations - (coverageMaxIterations ?? 0);
    const initialFocuses = coverageAssignments(rootMoves, this.workerCount);
    const coverage = await this.runStage(
      state,
      fallbackMove,
      weights,
      this.workers.map((worker) => {
        const focus = initialFocuses[worker.index];
        return {
          ...workerBaseOptions,
          fallbackProtection,
          simulateFoodSpawns,
          timeBudgetMs: coverageSearchBudgetMs,
          ...(coverageMaxIterations === undefined
            ? {}
            : { maxIterations: coverageMaxIterations }),
          seed: workerSeed(baseSeed, worker.index, 0),
          ...(focus === undefined ? {} : { rootMoveConstraint: focus }),
        };
      }),
      {
        computeEpochMs: startedAtEpochMs + coverageSearchBudgetMs,
        collectEpochMs: coverageDeadlineEpochMs,
      },
    );
    if (
      focusedMaxIterations === 0 ||
      Date.now() >= workerDeadlineEpochMs
    ) {
      return aggregateCoordinated([...coverage.values()]);
    }

    const coverageAggregate = aggregate([...coverage.values()]);
    if (
      rootCoverageConverged(
        coverageAggregate.move,
        rootMoves,
        coverageAggregate.rootStatistics,
      )
    ) {
      return aggregateCoordinated([...coverage.values()]);
    }
    const focusedMoves = focusAssignments(
      rootMoves,
      coverageAggregate.rootStatistics,
      this.workerCount,
    );
    const remainingBudgetMs = Math.max(
      0,
      workerDeadlineEpochMs - Date.now(),
    );
    if (remainingBudgetMs === 0) {
      return aggregateCoordinated([...coverage.values()]);
    }
    const focused = await this.runStage(
      state,
      fallbackMove,
      weights,
      this.workers.map((worker) => ({
        ...workerBaseOptions,
        fallbackProtection,
        simulateFoodSpawns,
        timeBudgetMs: remainingBudgetMs,
        ...(focusedMaxIterations === undefined
          ? {}
          : { maxIterations: focusedMaxIterations }),
        seed: workerSeed(baseSeed, worker.index, 1),
        rootMoveConstraint: focusedMoves[worker.index] ?? rootMoves[0]!,
        // Give the assigned contender the first sample, then let normal PUCT
        // converge across the entire root. Holding the constraint for the
        // whole phase would make visits measure simulation speed rather than
        // search preference.
        rootMoveConstraintIterations: 1,
      })),
      {
        computeEpochMs: workerDeadlineEpochMs,
        collectEpochMs: responseDeadlineEpochMs,
      },
    );

    const latest = new Map<number, MctsResult>(coverage);
    for (const [workerIndex, result] of focused) {
      const initial = coverage.get(workerIndex);
      latest.set(
        workerIndex,
        initial === undefined ? result : combineWorkerPhases(initial, result),
      );
    }
    return aggregateCoordinated([...latest.values()]);
  }

  clearGame(gameId: string): void {
    for (const worker of this.workers) {
      worker.clearGame(gameId);
    }
  }

  clear(): void {
    for (const worker of this.workers) {
      worker.clear();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}

export class SearchCoordinator {
  private readonly behaviorByGame = new Map<string, {
    previous: GameState | undefined;
    tracker: BehaviorHistoryTracker;
  }>();

  constructor(
    readonly pool = new PersistentSearchPool(),
    private readonly defaultWeights:
      Readonly<EvaluationWeights> = DEFAULT_EVALUATION_WEIGHTS,
    private readonly defaultSearchOptions: Readonly<MctsOptions> = {},
  ) {}

  async ready(): Promise<void> {
    await this.pool.ready();
  }

  async chooseMove(
    state: GameState,
    weights: Readonly<EvaluationWeights> = this.defaultWeights,
    searchOptions: Readonly<MctsOptions> = {},
  ): Promise<{ response: MoveResponse; diagnostics: PooledSearchResult }> {
    const opponentContexts = this.updateBehaviorHistory(state);
    const fallback = chooseStaticMove(state, weights);
    const mergedOptions = mergeSearchOptions(
      this.defaultSearchOptions,
      { ...searchOptions, opponentContexts },
    );
    const safetyEnabled = rootSafetyArbiterEnabled(
      mergedOptions.rootSafetyArbiter,
    );
    const diagnostics = await this.pool.search(
      state,
      fallback.move,
      weights,
      mergedOptions,
    );
    if (!safetyEnabled) {
      return { response: { move: diagnostics.move }, diagnostics };
    }
    const safety = analyzeRootSafety(state);
    const branchingReserveEnabled = rootBranchingReserveEnabled(
      mergedOptions.rootBranchingReserve,
    );
    const admissible = new Set(safety.admissibleMoves);
    const proposedIsAdmissible = admissible.has(diagnostics.move);
    const searchedAlternative = proposedIsAdmissible
      ? undefined
      : selectRootMoveStatistic(
        diagnostics.rootStatistics.filter(
          (item) =>
            admissible.has(item.move) && item.move !== diagnostics.move,
        ),
        state,
      );
    const staticPreferences = proposedIsAdmissible
      ? []
      : rankStaticMoves(state, weights).map((item) => item.direction);
    // Root statistics are already emitted in visit order. Reuse that order for
    // the optional second-stage guard without paying for another full static
    // ranking on ordinary accepted turns.
    const branchingPreferences = branchingReserveEnabled
      ? diagnostics.rootStatistics
        .filter((item) => item.move !== diagnostics.move)
        .map((item) => item.move)
      : [];
    const rootSafety = arbitrateRootMove(
      safety,
      diagnostics.move,
      [
        ...(searchedAlternative === undefined
          ? []
          : [searchedAlternative.move]),
        ...branchingPreferences,
        ...staticPreferences,
        ...diagnostics.rootStatistics.map((item) => item.move),
      ],
      branchingReserveEnabled
        ? { branchingReserve: { state, weights } }
        : {},
    );
    const authoritativeDiagnostics: PooledSearchResult = {
      ...diagnostics,
      move: rootSafety.move,
      rootSafety,
    };
    return {
      response: { move: rootSafety.move },
      diagnostics: authoritativeDiagnostics,
    };
  }

  startGame(gameId: string): void {
    this.pool.clearGame(gameId);
    this.behaviorByGame.delete(gameId);
  }

  endGame(gameId: string): void {
    this.pool.clearGame(gameId);
    this.behaviorByGame.delete(gameId);
  }

  async close(): Promise<void> {
    this.behaviorByGame.clear();
    await this.pool.close();
  }

  private updateBehaviorHistory(
    state: Readonly<GameState>,
  ): Readonly<Record<string, BehaviorHistorySnapshot>> {
    const game = this.behaviorByGame.get(state.game.id) ?? {
      previous: undefined,
      tracker: new BehaviorHistoryTracker(),
    };
    const previous = game.previous;
    if (
      previous !== undefined &&
      previous.game.id === state.game.id &&
      state.turn === previous.turn + 1
    ) {
      for (const before of previous.board.snakes) {
        const after = state.board.snakes.find((snake) => snake.id === before.id);
        if (after === undefined) continue;
        const move = inferObservedDirection(before, after);
        if (move !== undefined) {
          game.tracker.observe(previous, before.id, move);
        }
      }
    }
    game.previous = state as GameState;
    this.behaviorByGame.set(state.game.id, game);
    return Object.fromEntries(
      state.board.snakes
        .filter((snake) => snake.id !== state.you.id)
        .map((snake) => [snake.id, game.tracker.current(snake.id)]),
    );
  }
}
