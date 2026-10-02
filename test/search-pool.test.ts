import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initiativeRiskWeights,
  riskAdjustedValue,
  type MctsResult,
} from "../src/search/mcts.js";
import {
  aggregateSearchResults,
  PersistentSearchPool,
  rootCoverageConverged,
  SearchCoordinator,
} from "../src/search/search-pool.js";
import { remainingSearchBudgetMs } from "../src/search/search-worker-protocol.js";
import { strategicRootPrior } from "../src/search/strategic-root-prior.js";
import {
  chooseStaticMove,
  physicallyViableMoves,
} from "../src/strategy/static-policy.js";
import { strategicPosture } from "../src/strategy/strategic-posture.js";
import { gameState, opponent } from "./fixtures.js";

describe("persistent worker search pool", () => {
  it("never grants queued work a fresh budget after its absolute deadline", () => {
    assert.equal(remainingSearchBudgetMs(150, 100, 100), 50);
    assert.equal(remainingSearchBudgetMs(250, 25, 100), 25);
    assert.equal(remainingSearchBudgetMs(100, 25, 100), 0);
    assert.equal(remainingSearchBudgetMs(99, 25, 100), 0);
  });

  it("exposes coordinator readiness before the first search is served", async () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    const pool = new PersistentSearchPool({ workerCount: 1 });
    const coordinator = new SearchCoordinator(pool);

    try {
      await coordinator.ready();
      const result = await pool.search(
        state,
        chooseStaticMove(state).move,
        undefined,
        { timeBudgetMs: 1_000, maxIterations: 1, seed: 9 },
      );
      assert.equal(result.workersCompleted, 1);
      assert.equal(result.iterations, 1);
    } finally {
      await coordinator.close();
    }
  });

  it("composes the current coordinator with the static fallback at zero budget", async () => {
    const pool = new PersistentSearchPool({ workerCount: 1 });
    const coordinator = new SearchCoordinator(pool);
    const cases = [
      {
        state: gameState({
          width: 3,
          height: 3,
          youBody: [
            { x: 0, y: 0 },
            { x: 0, y: 1 },
            { x: 1, y: 1 },
          ],
        }),
        accepts: (move: string) => move === "right",
      },
      {
        state: gameState({
          opponents: [
            opponent("them", [
              { x: 7, y: 5 },
              { x: 6, y: 5 },
              { x: 6, y: 4 },
            ]),
          ],
        }),
        accepts: (move: string) => move !== "right",
      },
      {
        state: gameState({
          width: 4,
          height: 4,
          youBody: [
            { x: 1, y: 1 },
            { x: 1, y: 2 },
            { x: 2, y: 2 },
            { x: 2, y: 1 },
          ],
          opponents: [
            opponent("wall", [
              { x: 0, y: 1 },
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 2, y: 0 },
              { x: 3, y: 0 },
            ]),
          ],
        }),
        accepts: (move: string) => move === "right",
      },
    ];

    try {
      await coordinator.ready();
      for (const testCase of cases) {
        const result = await coordinator.chooseMove(
          testCase.state,
          undefined,
          { timeBudgetMs: 0 },
        );
        assert.equal(result.diagnostics.usedSearch, false);
        assert.equal(
          result.response.move,
          result.diagnostics.fallbackMove,
        );
        assert.ok(testCase.accepts(result.response.move));
      }
    } finally {
      await coordinator.close();
    }
  });

  it("merges downside moments and prefers the stable root action", () => {
    const state = gameState();
    const fallback = chooseStaticMove(state).move;
    const candidates = physicallyViableMoves(state);
    const risky = candidates.find((move) => move !== fallback)!;
    const result: MctsResult = {
      move: risky,
      fallbackMove: fallback,
      iterations: candidates.length * 10,
      elapsedMs: 10,
      deadlineReached: false,
      usedSearch: true,
      fallbackProtected: false,
      rootStatistics: candidates.map((move) => {
        const isRisky = move === risky;
        const meanValue = isRisky ? 0.6 : move === fallback ? 0.4 : 0.1;
        return {
          move,
          visits: 10,
          meanValue,
          outcomeCount: 3,
          valueSquareMean: isRisky ? 0.52 : meanValue * meanValue,
          forcedLossCount: isRisky ? 4 : 0,
          forcedLossRate: isRisky ? 0.4 : 0,
          valueStandardDeviation: isRisky ? 0.4 : 0,
          riskAdjustedValue: isRisky ? 0.38 : meanValue,
        };
      }),
      priorVisits: 0,
      reusedTree: false,
      cacheHits: 0,
      cacheMisses: 0,
    };

    const aggregate = aggregateSearchResults(
      state,
      fallback,
      [result, result],
      2,
      0.05,
    );
    const riskyStatistic = aggregate.rootStatistics.find(
      (candidate) => candidate.move === risky,
    );
    const adaptiveRisk = initiativeRiskWeights(
      strategicPosture(state).initiative,
    );
    const expectedRiskValue = riskAdjustedValue(
      0.6,
      0.4,
      0.4,
      20,
      adaptiveRisk.standardDeviationWeight,
      adaptiveRisk.forcedLossWeight,
    );

    assert.equal(aggregate.move, fallback);
    assert.equal(riskyStatistic?.forcedLossCount, 8);
    assert.ok(
      Math.abs(
        (riskyStatistic?.riskAdjustedValue ?? 0) - expectedRiskValue,
      ) < 1e-12,
    );
    assert.ok((riskyStatistic?.riskAdjustedValue ?? 1) < 0.4);
  });

  it("overrides a heavily visited root action only when it is clearly more fatal", () => {
    const state = gameState();
    const candidates = physicallyViableMoves(state);
    assert.ok(candidates.includes("left"));
    assert.ok(candidates.includes("right"));
    const rootStatistics = candidates.map((move) => {
      if (move === "left") {
        return {
          move,
          visits: 521,
          meanValue: 0,
          outcomeCount: 29,
          downsideSquareMean: 1,
          forcedLossCount: 521,
        };
      }
      if (move === "right") {
        return {
          move,
          visits: 117,
          meanValue: 0.3,
          outcomeCount: 19,
          downsideSquareMean: 0.01,
          forcedLossCount: 12,
        };
      }
      return {
        move,
        visits: 33,
        meanValue: -0.2,
        outcomeCount: 8,
        downsideSquareMean: 0.64,
        forcedLossCount: 25,
      };
    });
    const workerResult: MctsResult = {
      move: "left",
      fallbackMove: "left",
      iterations: rootStatistics.reduce((sum, item) => sum + item.visits, 0),
      elapsedMs: 10,
      deadlineReached: false,
      usedSearch: true,
      fallbackProtected: false,
      rootStatistics,
      priorVisits: 0,
      reusedTree: false,
      cacheHits: 0,
      cacheMisses: 0,
    };

    const aggregate = aggregateSearchResults(
      state,
      "left",
      [workerResult],
      1,
      0.05,
    );

    assert.equal(aggregate.rootStatistics[0]?.move, "left");
    assert.equal(aggregate.move, "right");
  });

  it("stops after coverage only for well-sampled, separated root actions", () => {
    const separated = [
      {
        move: "up" as const,
        visits: 64,
        meanValue: 0.8,
        outcomeCount: 8,
        valueStandardDeviation: 0.1,
        riskAdjustedValue: 0.8,
        forcedLossRate: 0.02,
      },
      {
        move: "left" as const,
        visits: 64,
        meanValue: 0.1,
        outcomeCount: 8,
        valueStandardDeviation: 0.1,
        riskAdjustedValue: 0.1,
        forcedLossRate: 0.05,
      },
    ];

    assert.equal(
      rootCoverageConverged("up", ["up", "left"], separated),
      true,
    );
    assert.equal(
      rootCoverageConverged("left", ["up", "left"], separated),
      false,
    );
    assert.equal(
      rootCoverageConverged(
        "up",
        ["up", "left"],
        separated.map((item) =>
          item.move === "up" ? { ...item, visits: 15 } : item
        ),
      ),
      false,
    );
    assert.equal(
      rootCoverageConverged(
        "up",
        ["up", "left"],
        separated.map((item) =>
          item.move === "left"
            ? { ...item, riskAdjustedValue: 0.69, meanValue: 0.69 }
            : item
        ),
      ),
      false,
    );
  });

  it("keeps aggregate MCTS authoritative unless the ablation is enabled", () => {
    const state = gameState();
    const fallback = chooseStaticMove(state).move;
    const candidates = physicallyViableMoves(state);
    const alternative = candidates.find((move) => move !== fallback);
    assert.notEqual(alternative, undefined);

    const rootStatistics = candidates.map((move) => ({
      move,
      visits: move === alternative ? 12 : move === fallback ? 11 : 10,
      meanValue: move === alternative ? 0.2 : move === fallback ? 0.19 : 0.1,
      outcomeCount: 3,
    }));
    const workerResult: MctsResult = {
      move: alternative!,
      fallbackMove: fallback,
      iterations: rootStatistics.reduce((sum, item) => sum + item.visits, 0),
      elapsedMs: 10,
      deadlineReached: false,
      usedSearch: true,
      fallbackProtected: false,
      rootStatistics,
      priorVisits: 0,
      reusedTree: false,
      cacheHits: 0,
      cacheMisses: 0,
    };

    const authoritative = aggregateSearchResults(
      state,
      fallback,
      [workerResult],
      1,
      0.05,
    );
    const protectedAblation = aggregateSearchResults(
      state,
      fallback,
      [workerResult],
      1,
      0.05,
      true,
    );

    assert.equal(authoritative.move, alternative);
    assert.equal(authoritative.fallbackProtected, false);
    assert.equal(protectedAblation.move, fallback);
    assert.equal(protectedAblation.fallbackProtected, true);
  });

  it("aggregates independent workers and preserves their per-game trees", async () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
      food: [{ x: 3, y: 5 }],
    });
    const fallback = chooseStaticMove(state).move;
    const pool = new PersistentSearchPool({
      workerCount: 2,
      dispatchReserveMs: 5,
    });

    try {
      const first = await pool.search(state, fallback, undefined, {
        timeBudgetMs: 1_000,
        maxIterations: 16,
        maxTreeDepth: 4,
        rolloutDepth: 2,
        seed: 23,
      });
      assert.equal(first.workersRequested, 2);
      assert.equal(first.workersCompleted, 2);
      assert.equal(first.iterations, 32);
      assert.equal(
        first.rootStatistics.reduce((sum, item) => sum + item.visits, 0),
        32,
      );

      const second = await pool.search(state, fallback, undefined, {
        timeBudgetMs: 1_000,
        maxIterations: 8,
        maxTreeDepth: 4,
        rolloutDepth: 2,
        seed: 23,
      });
      assert.equal(second.workersCompleted, 2);
      assert.equal(second.iterations, 16);
      assert.equal(second.priorVisits, 32);
      assert.equal(second.reusedTree, true);
      assert.ok(second.cacheHits > 0);

      pool.clearGame(state.game.id);
      const afterClear = await pool.search(state, fallback, undefined, {
        timeBudgetMs: 1_000,
        maxIterations: 1,
        seed: 23,
      });
      assert.equal(afterClear.priorVisits, 0);
      assert.equal(afterClear.reusedTree, false);
    } finally {
      await pool.close();
    }
  });

  it("preserves each game tree when distinct game ids are interleaved", async () => {
    const first = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    first.game.id = "tree-continuity-a";
    const second = structuredClone(first);
    second.game.id = "tree-continuity-b";
    const pool = new PersistentSearchPool({ workerCount: 1 });
    const options = {
      timeBudgetMs: 1_000,
      maxIterations: 2,
      maxTreeDepth: 2,
      rolloutDepth: 0,
      simulateFoodSpawns: false,
      seed: 812,
    } as const;

    try {
      const firstA = await pool.search(
        first,
        chooseStaticMove(first).move,
        undefined,
        options,
      );
      const firstB = await pool.search(
        second,
        chooseStaticMove(second).move,
        undefined,
        options,
      );
      const continuedA = await pool.search(
        first,
        chooseStaticMove(first).move,
        undefined,
        options,
      );
      const continuedB = await pool.search(
        second,
        chooseStaticMove(second).move,
        undefined,
        options,
      );

      assert.equal(firstA.reusedTree, false);
      assert.equal(firstB.reusedTree, false);
      assert.equal(continuedA.reusedTree, true);
      assert.equal(continuedB.reusedTree, true);
      assert.ok(continuedA.priorVisits > 0);
      assert.ok(continuedB.priorVisits > 0);

      pool.clearGame(first.game.id);
      const resetA = await pool.search(
        first,
        chooseStaticMove(first).move,
        undefined,
        options,
      );
      const stillWarmB = await pool.search(
        second,
        chooseStaticMove(second).move,
        undefined,
        options,
      );
      assert.equal(resetA.reusedTree, false);
      assert.equal(stillWarmB.reusedTree, true);
    } finally {
      await pool.close();
    }
  });

  it("coordinates four workers to cover every physical root action", async () => {
    const state = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    const fallback = chooseStaticMove(state).move;
    const candidates = physicallyViableMoves(state);
    assert.ok(candidates.length >= 2);
    const pool = new PersistentSearchPool({
      workerCount: 4,
      dispatchReserveMs: 5,
    });

    try {
      const result = await pool.search(state, fallback, undefined, {
        timeBudgetMs: 1_000,
        maxIterations: 4,
        maxTreeDepth: 3,
        rolloutDepth: 1,
        simulateFoodSpawns: false,
        seed: 77,
      });

      assert.equal(result.workersCompleted, 4);
      assert.equal(result.iterations, 16);
      assert.equal(result.priorVisits, 0);
      assert.equal(result.usedSearch, true);
      assert.equal(result.deadlineReached, false);
      assert.equal(
        result.rootStatistics.reduce((sum, item) => sum + item.visits, 0),
        16,
      );
      for (const move of candidates) {
        assert.ok(
          (result.rootStatistics.find((item) => item.move === move)?.visits ??
            0) > 0,
        );
      }
    } finally {
      await pool.close();
    }
  });

  it("sends one strategic root distribution consistently through the worker protocol", async () => {
    const state = gameState({
      opponents: [
        opponent("target", [
          { x: 7, y: 5 },
          { x: 7, y: 4 },
          { x: 7, y: 3 },
        ]),
      ],
      food: [{ x: 6, y: 5 }],
    });
    const moves = physicallyViableMoves(state);
    const expected = strategicRootPrior(state, moves);
    const pool = new PersistentSearchPool({
      workerCount: 2,
      dispatchReserveMs: 5,
    });

    try {
      const result = await pool.search(
        state,
        chooseStaticMove(state).move,
        undefined,
        {
          timeBudgetMs: 1_000,
          maxIterations: moves.length,
          maxTreeDepth: 2,
          rolloutDepth: 0,
          simulateFoodSpawns: false,
          seed: 790,
        },
      );

      for (const candidate of expected.candidates) {
        const actual = result.rootStatistics.find(
          (item) => item.move === candidate.move,
        );
        assert.ok(actual !== undefined);
        assert.ok(
          Math.abs((actual.prior ?? 0) - candidate.probability) < 1e-12,
        );
      }
    } finally {
      await pool.close();
    }
  });

  it("returns the fallback without dispatching at zero budget", async () => {
    const state = gameState();
    const fallback = chooseStaticMove(state).move;
    const pool = new PersistentSearchPool({ workerCount: 1 });

    try {
      const result = await pool.search(state, fallback, undefined, {
        timeBudgetMs: 0,
      });
      assert.equal(result.move, fallback);
      assert.equal(result.workersCompleted, 0);
      assert.equal(result.usedSearch, false);
    } finally {
      await pool.close();
    }
  });

  it("uses the remaining budget when slow workers miss coordinated coverage", async () => {
    const blockingState = gameState({
      opponents: [
        opponent("blocking-opponent", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    blockingState.game.id = "pool-slow-coverage-blocker";
    const state = gameState({
      opponents: [
        opponent("target-opponent", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
      food: [{ x: 3, y: 5 }],
    });
    state.game.id = "pool-slow-coverage-target";
    const fallback = chooseStaticMove(state).move;
    const candidates = physicallyViableMoves(state);
    assert.ok(candidates.length > 1);
    const pool = new PersistentSearchPool({
      workerCount: 4,
      dispatchReserveMs: 10,
    });

    try {
      await pool.ready();
      // Keep every worker occupied beyond the target search's short coverage
      // window. The blocker stays below the coordinated-search threshold so it
      // holds each worker in one uninterrupted stage.
      const blocking = pool.search(
        blockingState,
        chooseStaticMove(blockingState).move,
        undefined,
        {
          timeBudgetMs: 99,
          maxIterations: 1_000_000,
          maxTreeDepth: 8,
          rolloutDepth: 6,
          simulateFoodSpawns: false,
          seed: 901,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = await pool.search(state, fallback, undefined, {
        timeBudgetMs: 220,
        maxIterations: 1_000_000,
        maxTreeDepth: 4,
        rolloutDepth: 2,
        simulateFoodSpawns: false,
        seed: 902,
      });
      await blocking;

      assert.equal(result.workersRequested, 4);
      assert.ok(result.workersCompleted > 0);
      assert.ok(result.iterations > 0);
      assert.equal(result.usedSearch, true);
      for (const move of candidates) {
        assert.ok(
          (result.rootStatistics.find((item) => item.move === move)?.visits ??
            0) > 0,
        );
      }
    } finally {
      await pool.close();
    }
  });

  it("drops a timed-out queued search without contaminating its next tree", async () => {
    const warmState = gameState({
      opponents: [
        opponent("warm-opponent", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    warmState.game.id = "pool-ready-handshake";
    const blockedState = gameState({
      opponents: [
        opponent("blocker", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
      food: [{ x: 3, y: 5 }],
    });
    blockedState.game.id = "pool-busy-worker";
    const staleState = gameState({
      opponents: [
        opponent("stale-opponent", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    staleState.game.id = "pool-stale-request";
    const pool = new PersistentSearchPool({
      workerCount: 1,
      dispatchReserveMs: 0,
    });

    try {
      const warm = await pool.search(
        warmState,
        chooseStaticMove(warmState).move,
        undefined,
        { timeBudgetMs: 1_000, maxIterations: 1, seed: 1 },
      );
      assert.equal(warm.workersCompleted, 1);

      const blocking = pool.search(
        blockedState,
        chooseStaticMove(blockedState).move,
        undefined,
        {
          timeBudgetMs: 150,
          maxIterations: 100_000,
          maxTreeDepth: 8,
          rolloutDepth: 6,
          seed: 2,
        },
      );
      const stale = await pool.search(
        staleState,
        chooseStaticMove(staleState).move,
        undefined,
        { timeBudgetMs: 5, maxIterations: 100_000, seed: 3 },
      );
      assert.equal(stale.workersCompleted, 0);
      assert.equal(stale.iterations, 0);

      await blocking;
      const fresh = await pool.search(
        staleState,
        chooseStaticMove(staleState).move,
        undefined,
        { timeBudgetMs: 1_000, maxIterations: 1, seed: 4 },
      );
      assert.equal(fresh.workersCompleted, 1);
      assert.equal(fresh.iterations, 1);
      assert.equal(fresh.priorVisits, 0);
    } finally {
      await pool.close();
    }
  });
});
