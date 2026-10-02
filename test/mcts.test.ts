import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Direction } from "../src/api/types.js";
import {
  chanceOutcomeLimit,
  centeredValueFromEvaluation,
  defaultSearchBudgetMs,
  initiativeRiskWeights,
  MctsMemory,
  riskAdjustedValue,
  searchMove,
  selectRootMoveStatistic,
  valueWithEliminationProgress,
} from "../src/search/mcts.js";
import { resolveEvaluationWeights } from "../src/evaluation/weights.js";
import {
  evaluateMove,
  evaluateState,
} from "../src/evaluation/evaluate-state.js";
import {
  nonTerminalEvaluationScale,
  ongoingEvaluationScore,
  valueProbabilityForFeatures,
} from "../src/evaluation/value-scale.js";
import {
  chooseStaticMove,
  immediatelySafeMoves,
  physicallyViableMoves,
} from "../src/strategy/static-policy.js";
import { strategicPosture } from "../src/strategy/strategic-posture.js";
import { gameState, opponent } from "./fixtures.js";

const SEARCH_STATE = gameState({
  opponents: [
    opponent("them", [
      { x: 8, y: 8 },
      { x: 8, y: 7 },
      { x: 8, y: 6 },
    ]),
  ],
  food: [{ x: 3, y: 5 }],
});

function fallbackMove(): Direction {
  return chooseStaticMove(SEARCH_STATE).move;
}

describe("deadline-aware MCTS", () => {
  it("maps evaluator scores onto the centered value-training scale", () => {
    const score = 0.75;
    const scale = 2;
    const trainedWinProbability = 1 / (1 + Math.exp(-4 * score / scale));

    assert.equal(centeredValueFromEvaluation(0, scale), 0);
    assert.ok(
      Math.abs(
        centeredValueFromEvaluation(score, scale) -
          (2 * trainedWinProbability - 1),
      ) < 1e-12,
    );
    assert.equal(
      centeredValueFromEvaluation(-score, scale),
      -centeredValueFromEvaluation(score, scale),
    );
  });

  it("penalizes variance and observed forced losses after enough evidence", () => {
    assert.equal(riskAdjustedValue(0.4, 0.5, 0.25, 3), 0.4);
    assert.equal(
      riskAdjustedValue(0.4, 0.5, 0.25, 20),
      0.4 - 0.35 * 0.5 - 0.4 * 0.25,
    );
  });

  it("relaxes variance aversion with initiative without relaxing forced losses", () => {
    const cautious = initiativeRiskWeights(0);
    const moderate = initiativeRiskWeights(0.5);
    const initiative = initiativeRiskWeights(1);

    assert.equal(cautious.standardDeviationWeight, 0.35);
    assert.ok(
      initiative.standardDeviationWeight < moderate.standardDeviationWeight,
    );
    assert.ok(
      moderate.standardDeviationWeight < cautious.standardDeviationWeight,
    );
    assert.equal(initiative.standardDeviationWeight, 0.175);
    assert.equal(
      initiative.forcedLossWeight,
      cautious.forcedLossWeight,
    );

    const withoutForcedLoss = riskAdjustedValue(
      0.4,
      0.5,
      0,
      20,
      initiative.standardDeviationWeight,
      initiative.forcedLossWeight,
    );
    const withForcedLoss = riskAdjustedValue(
      0.4,
      0.5,
      0.5,
      20,
      initiative.standardDeviationWeight,
      initiative.forcedLossWeight,
    );
    assert.ok(
      Math.abs(withoutForcedLoss - withForcedLoss - 0.2) < 1e-12,
    );
  });

  it("uses the root posture when publishing risk-adjusted statistics", () => {
    const result = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      {
        timeBudgetMs: 1_000,
        maxIterations: 64,
        maxTreeDepth: 3,
        rolloutDepth: 2,
        simulateFoodSpawns: false,
        seed: 20260921,
        now: () => 0,
      },
    );
    const risk = initiativeRiskWeights(
      strategicPosture(SEARCH_STATE).initiative,
    );

    for (const statistic of result.rootStatistics) {
      assert.ok(statistic.visits >= 4);
      const expected = riskAdjustedValue(
        statistic.meanValue,
        statistic.downsideDeviation ?? 0,
        statistic.forcedLossRate ?? 0,
        statistic.visits,
        risk.standardDeviationWeight,
        risk.forcedLossWeight,
      );
      assert.ok(
        Math.abs((statistic.riskAdjustedValue ?? 0) - expected) < 1e-12,
      );
    }
  });

  it("vetoes a prior-driven visit leader only with strong risk evidence", () => {
    const fatal = {
      move: "left" as const,
      visits: 521,
      meanValue: -0.981,
      // A deterministic death can have one distinct chance outcome despite
      // hundreds of samples; visits, not outcome cardinality, are evidence.
      outcomeCount: 1,
      forcedLossRate: 0.9885,
      riskAdjustedValue: -1,
    };
    const escape = {
      move: "right" as const,
      visits: 117,
      meanValue: -0.117,
      outcomeCount: 19,
      forcedLossRate: 0.4359,
      riskAdjustedValue: -0.5226,
    };
    const losing = {
      move: "down" as const,
      visits: 27,
      meanValue: -0.882,
      outcomeCount: 12,
      forcedLossRate: 0.8889,
      riskAdjustedValue: -1,
    };

    assert.equal(
      selectRootMoveStatistic([fatal, escape, losing])?.move,
      "right",
    );
    assert.equal(
      selectRootMoveStatistic([fatal, { ...escape, visits: 31 }])?.move,
      "left",
    );
    assert.equal(
      selectRootMoveStatistic([
        fatal,
        { ...escape, riskAdjustedValue: -0.76 },
      ])?.move,
      "left",
    );
    assert.equal(
      selectRootMoveStatistic([
        fatal,
        { ...escape, forcedLossRate: 0.7986 },
      ])?.move,
      "left",
    );
  });

  it("does not abandon a critical food route unless search proves a win", () => {
    const state = gameState({
      width: 7,
      height: 7,
      health: 30,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
      ],
      opponents: [opponent("shorter", [
        { x: 5, y: 3 },
        { x: 5, y: 2 },
        { x: 6, y: 2 },
      ])],
      food: [{ x: 1, y: 3 }],
    });
    const recover = {
      move: "left" as const,
      visits: 12,
      meanValue: 0.2,
      outcomeCount: 4,
      downsideDeviation: 0.1,
      forcedLossRate: 0,
    };
    const abandon = {
      move: "right" as const,
      visits: 120,
      meanValue: 0.6,
      outcomeCount: 8,
      downsideDeviation: 0.1,
      forcedLossRate: 0,
    };

    assert.equal(
      selectRootMoveStatistic([recover, abandon], state)?.move,
      "left",
    );
    assert.equal(
      selectRootMoveStatistic([
        recover,
        {
          ...abandon,
          meanValue: 1,
          downsideDeviation: 0,
        },
      ], state)?.move,
      "right",
    );
  });

  it("replays live turn 89 as bounded tactical catch-up", () => {
    const state = gameState({
      health: 79,
      youBody: [
        { x: 4, y: 7 }, { x: 3, y: 7 }, { x: 3, y: 6 },
        { x: 3, y: 5 }, { x: 3, y: 4 }, { x: 4, y: 4 },
        { x: 4, y: 5 }, { x: 4, y: 6 },
      ],
      opponents: [
        opponent("davibora", [
          { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 },
          { x: 2, y: 2 }, { x: 2, y: 3 }, { x: 1, y: 3 },
        ]),
        opponent("palaserpiente", [
          { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 },
          { x: 8, y: 6 }, { x: 8, y: 7 }, { x: 9, y: 7 },
          { x: 9, y: 8 },
        ]),
        opponent("cascabel", [
          { x: 10, y: 7 }, { x: 10, y: 6 }, { x: 10, y: 5 },
          { x: 10, y: 4 }, { x: 9, y: 4 }, { x: 9, y: 3 },
          { x: 8, y: 3 }, { x: 8, y: 2 }, { x: 7, y: 2 },
          { x: 6, y: 2 }, { x: 6, y: 1 },
        ]),
      ],
      food: [{ x: 5, y: 10 }],
    });
    const up = evaluateMove(state, "up").tacticalIntent;
    const right = evaluateMove(state, "right").tacticalIntent;
    const down = evaluateMove(state, "down").tacticalIntent;

    assert.equal(up.kind, "RESOURCE_GROWTH");
    assert.equal(right.kind, "RESOURCE_GROWTH");
    assert.equal(up.strategicCatchUpRequired, true);
    assert.equal(up.resourceGate, true);
    assert.equal(right.resourceGate, true);
    assert.equal(down.resourceGate, false);
    assert.equal(
      selectRootMoveStatistic([
        {
          move: "down",
          visits: 86,
          meanValue: -0.0439,
          outcomeCount: 24,
          downsideDeviation: 0.2772,
          forcedLossRate: 0.0465,
        },
        {
          move: "up",
          visits: 43,
          meanValue: -0.1402,
          outcomeCount: 18,
          downsideDeviation: 0.3653,
          forcedLossRate: 0.1163,
        },
        {
          move: "right",
          visits: 40,
          meanValue: -0.167,
          outcomeCount: 16,
          downsideDeviation: 0.4631,
          forcedLossRate: 0.2,
        },
      ], state)?.move,
      "up",
    );
  });

  it("reuses a tree while workers change their coordinated root focus", () => {
    const memory = new MctsMemory();
    const options = {
      timeBudgetMs: 1_000,
      maxIterations: 8,
      maxTreeDepth: 3,
      rolloutDepth: 1,
      simulateFoodSpawns: false,
      seed: 90210,
      now: () => 0,
    } as const;
    const first = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      { ...options, rootMoveConstraint: "left" },
      memory,
    );
    const second = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      { ...options, rootMoveConstraint: "right" },
      memory,
    );

    assert.equal(first.rootStatistics.length, 1);
    assert.equal(first.rootStatistics[0]?.move, "left");
    assert.equal(first.rootStatistics[0]?.visits, 8);
    assert.equal(second.reusedTree, true);
    assert.equal(second.priorVisits, 8);
    assert.equal(
      second.rootStatistics.find((item) => item.move === "right")?.visits,
      8,
    );
  });

  it("expands the move with the strongest supplied root prior first", () => {
    const result = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      {
        timeBudgetMs: 1_000,
        maxIterations: 1,
        maxTreeDepth: 2,
        rolloutDepth: 0,
        simulateFoodSpawns: false,
        rootPolicyPrior: { left: 0.01, right: 0.98, up: 0.01 },
        seed: 101,
        now: () => 0,
      },
    );

    assert.equal(result.rootStatistics.length, 1);
    assert.equal(result.rootStatistics[0]?.move, "right");
    assert.ok(Math.abs((result.rootStatistics[0]?.prior ?? 0) - 0.98) < 1e-12);
  });

  it("refreshes strategic priors when a persistent node becomes the root", () => {
    const memory = new MctsMemory();
    const shared = {
      timeBudgetMs: 1_000,
      maxIterations: 1,
      maxTreeDepth: 2,
      rolloutDepth: 0,
      simulateFoodSpawns: false,
      seed: 102,
      now: () => 0,
    } as const;
    const first = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      {
        ...shared,
        rootPolicyPrior: { left: 1, right: 0, up: 0 },
      },
      memory,
    );
    const second = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      {
        ...shared,
        rootPolicyPrior: { left: 0, right: 1, up: 0 },
      },
      memory,
    );

    assert.equal(first.rootStatistics[0]?.move, "left");
    assert.equal(second.reusedTree, true);
    assert.equal(second.priorVisits, 1);
    assert.equal(
      second.rootStatistics.find((item) => item.move === "right")?.prior,
      1,
    );
    assert.equal(
      second.rootStatistics.find((item) => item.move === "left")?.prior,
      0,
    );
    assert.equal(
      second.rootStatistics.find((item) => item.move === "right")?.visits,
      1,
    );
  });

  it("releases a temporary root focus back to normal PUCT", () => {
    const result = searchMove(
      SEARCH_STATE,
      fallbackMove(),
      undefined,
      {
        timeBudgetMs: 1_000,
        maxIterations: 8,
        maxTreeDepth: 3,
        rolloutDepth: 1,
        simulateFoodSpawns: false,
        seed: 90211,
        now: () => 0,
        rootMoveConstraint: "left",
        rootMoveConstraintIterations: 1,
      },
    );

    assert.equal(
      result.rootStatistics.length,
      physicallyViableMoves(SEARCH_STATE).length,
    );
    assert.ok(
      result.rootStatistics.every((statistic) => statistic.visits > 0),
    );
  });

  it("bounds stochastic chance widening", () => {
    assert.equal(chanceOutcomeLimit(0), 2);
    assert.ok(chanceOutcomeLimit(16) > chanceOutcomeLimit(1));
    assert.equal(chanceOutcomeLimit(10_000), 8);
  });

  it("keeps capped unseen chance outcomes in the sampled loss rate", () => {
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 1 },
      ],
      opponents: [
        opponent("them", [
          { x: 1, y: 1 },
          { x: 1, y: 2 },
          { x: 2, y: 2 },
          { x: 2, y: 1 },
        ]),
      ],
    });
    state.game.ruleset.settings.minimumFood = 0;
    state.game.ruleset.settings.foodSpawnChance = 0;

    const result = searchMove(state, "right", undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 4_000,
      maxTreeDepth: 1,
      rolloutDepth: 0,
      simulateFoodSpawns: false,
      chanceWideningMinOutcomes: 1,
      chanceWideningMaxOutcomes: 1,
      seed: 20260920,
      now: () => 0,
    });
    const [statistic] = result.rootStatistics;

    assert.equal(result.iterations, 4_000);
    assert.equal(statistic?.move, "right");
    assert.equal(statistic.outcomeCount, 1);
    assert.ok((statistic.forcedLossRate ?? 0) > 0.47);
    assert.ok((statistic.forcedLossRate ?? 1) < 0.53);
  });

  it("does not treat the constant survival intercept as leaf evidence", () => {
    const fallback = fallbackMove();
    const options = {
      timeBudgetMs: 1_000,
      maxIterations: 32,
      maxTreeDepth: 3,
      rolloutDepth: 2,
      simulateFoodSpawns: false,
      seed: 44,
      now: () => 0,
    } as const;
    const zero = searchMove(
      SEARCH_STATE,
      fallback,
      resolveEvaluationWeights({ survival: 0 }),
      options,
    );
    const huge = searchMove(
      SEARCH_STATE,
      fallback,
      resolveEvaluationWeights({ survival: 10_000 }),
      options,
    );

    assert.deepEqual(
      huge.rootStatistics.map(({ move, visits }) => ({ move, visits })),
      zero.rootStatistics.map(({ move, visits }) => ({ move, visits })),
    );
    for (const statistic of huge.rootStatistics) {
      const baseline = zero.rootStatistics.find(
        (candidate) => candidate.move === statistic.move,
      );
      assert.ok(baseline !== undefined);
      assert.ok(Math.abs(statistic.meanValue - baseline.meanValue) < 1e-12);
      assert.ok(
        Math.abs(
          (statistic.riskAdjustedValue ?? 0) -
            (baseline.riskAdjustedValue ?? 0),
        ) < 1e-12,
      );
    }
    assert.equal(huge.move, zero.move);
  });

  it("uses the same centered value scale as offline probability training", () => {
    const weights = resolveEvaluationWeights({ survival: 10_000 });
    const valueBias = -0.75;
    const evaluation = evaluateState(SEARCH_STATE, SEARCH_STATE.you.id, weights);
    const probability = valueProbabilityForFeatures(
      evaluation.features,
      weights,
      SEARCH_STATE.board.snakes.length,
      valueBias,
    );
    const centered = centeredValueFromEvaluation(
      ongoingEvaluationScore(evaluation.features, weights),
      nonTerminalEvaluationScale(weights),
      SEARCH_STATE.board.snakes.length,
      valueBias,
    );

    assert.ok(Math.abs(centered - (2 * probability - 1)) < 1e-12);
    assert.equal(
      probability,
      valueProbabilityForFeatures(
        evaluation.features,
        resolveEvaluationWeights({ survival: 0 }),
        SEARCH_STATE.board.snakes.length,
        valueBias,
      ),
    );
  });

  it("uses a neutral one-winner prior for each multiplayer phase", () => {
    const scale = 100;
    assert.ok(Math.abs(centeredValueFromEvaluation(0, scale, 4) + 0.5) < 1e-12);
    assert.ok(
      Math.abs(centeredValueFromEvaluation(0, scale, 3) + 1 / 3) < 1e-12,
    );
    assert.equal(centeredValueFromEvaluation(0, scale, 2), 0);
  });

  it("rewards non-terminal eliminations in proportion to opponents remaining", () => {
    const base = 0.2;
    const inFourPlayer = valueWithEliminationProgress(base, 3, 2, 0.18);
    const inThreePlayer = valueWithEliminationProgress(base, 2, 1, 0.18);

    assert.equal(valueWithEliminationProgress(base, 3, 3, 0.18), base);
    assert.ok(inFourPlayer > base);
    assert.ok(inThreePlayer > inFourPlayer);
    assert.equal(valueWithEliminationProgress(1, 3, 0, 0.18), 1);
    assert.equal(valueWithEliminationProgress(-1, 3, 2, 0.18), -1);
  });

  it("returns the precomputed fallback without starting search at zero budget", () => {
    const fallback = fallbackMove();
    const result = searchMove(SEARCH_STATE, fallback, undefined, {
      timeBudgetMs: 0,
      now: () => 100,
    });

    assert.equal(result.move, fallback);
    assert.equal(result.iterations, 0);
    assert.equal(result.usedSearch, false);
    assert.equal(result.deadlineReached, true);
  });

  it("is reproducible for a fixed seed and iteration budget", () => {
    const options = {
      timeBudgetMs: 1_000,
      maxIterations: 32,
      maxTreeDepth: 4,
      rolloutDepth: 3,
      seed: 42,
      now: () => 0,
    } as const;
    const fallback = fallbackMove();
    const first = searchMove(SEARCH_STATE, fallback, undefined, options);
    const second = searchMove(SEARCH_STATE, fallback, undefined, options);

    assert.equal(first.iterations, 32);
    assert.equal(first.usedSearch, true);
    assert.deepEqual(second, first);
    assert.equal(
      first.rootStatistics.reduce((sum, item) => sum + item.visits, 0),
      first.iterations,
    );
  });

  it("stops when an injected monotonic clock reaches the deadline", () => {
    let tick = 0;
    const result = searchMove(SEARCH_STATE, fallbackMove(), undefined, {
      timeBudgetMs: 8,
      maxIterations: 10_000,
      seed: 7,
      now: () => tick++,
    });

    assert.ok(result.iterations < 10_000);
    assert.equal(result.deadlineReached, true);
  });

  it("searches contested viable moves when every conservative move is threatened", () => {
    const state = gameState({
      youBody: [
        { x: 4, y: 6 },
        { x: 4, y: 7 },
        { x: 3, y: 7 },
      ],
      opponents: [
        opponent("top-right", [
          { x: 6, y: 4 },
          { x: 7, y: 4 },
          { x: 7, y: 3 },
        ]),
        opponent("bottom-right", [
          { x: 6, y: 6 },
          { x: 7, y: 6 },
          { x: 7, y: 7 },
        ]),
        opponent("left", [
          { x: 3, y: 5 },
          { x: 3, y: 4 },
          { x: 3, y: 3 },
        ]),
      ],
    });
    const fallback = chooseStaticMove(state).move;
    const result = searchMove(state, fallback, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 32,
      seed: 17,
      now: () => 0,
    });

    assert.equal(result.usedSearch, true);
    assert.ok(["down", "left", "right"].includes(result.move));
    assert.deepEqual(
      new Set(result.rootStatistics.map((candidate) => candidate.move)),
      new Set(["down", "left", "right"]),
    );
  });

  it("lets MCTS inspect a contested attack even when safe moves exist", () => {
    const state = gameState({
      youBody: [
        { x: 4, y: 5 },
        { x: 4, y: 4 },
        { x: 4, y: 3 },
      ],
      opponents: [
        opponent("them", [
          { x: 6, y: 5 },
          { x: 6, y: 4 },
          { x: 6, y: 3 },
        ]),
      ],
    });

    assert.ok(!immediatelySafeMoves(state).includes("right"));
    assert.ok(physicallyViableMoves(state).includes("right"));
    const result = searchMove(state, chooseStaticMove(state).move, undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 32,
      maxTreeDepth: 3,
      rolloutDepth: 2,
      seed: 91,
      now: () => 0,
    });

    assert.equal(result.usedSearch, true);
    assert.ok(result.rootStatistics.some((candidate) => candidate.move === "right"));
  });

  it("does not reserve a head-to-head square for an opponent that dies there", () => {
    const sharedCandidate = { x: 6, y: 5 };
    const exhaustedOpponent = {
      ...opponent("them", [
        { x: 7, y: 5 },
        { x: 7, y: 4 },
        { x: 7, y: 3 },
      ]),
      health: 1,
    };
    const lethalHazard = gameState({
      opponents: [exhaustedOpponent],
      hazards: [sharedCandidate],
    });
    const rescuedByFood = gameState({
      opponents: [exhaustedOpponent],
      hazards: [sharedCandidate],
      food: [sharedCandidate],
    });

    assert.ok(immediatelySafeMoves(lethalHazard).includes("right"));
    assert.ok(!immediatelySafeMoves(rescuedByFood).includes("right"));
  });

  it("treats every unique rival tail as vacating this turn", () => {
    const uniqueTail = opponent("them", [
      { x: 3, y: 3 },
      { x: 3, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 1 },
    ]);
    const state = gameState({
      width: 6,
      height: 6,
      youBody: [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }],
      opponents: [uniqueTail],
    });
    const duplicatedTail = {
      ...uniqueTail,
      body: [...uniqueTail.body, { x: 2, y: 1 }],
      length: uniqueTail.length + 1,
    };

    assert.ok(immediatelySafeMoves(state).includes("right"));
    assert.ok(physicallyViableMoves(state).includes("right"));
    assert.ok(!physicallyViableMoves({
      ...state,
      board: { ...state.board, snakes: [state.you, duplicatedTail] },
    }).includes("right"));
  });

  it("simulates protocol directions when every survivable move is gone", () => {
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
      ],
      opponents: [opponent("them", [{ x: 2, y: 2 }])],
    });
    const result = searchMove(state, "up", undefined, {
      timeBudgetMs: 1_000,
      maxIterations: 16,
      maxTreeDepth: 2,
      rolloutDepth: 1,
      simulateFoodSpawns: false,
      seed: 123,
      now: () => 0,
    });

    assert.equal(physicallyViableMoves(state).length, 0);
    assert.equal(result.usedSearch, true);
    assert.deepEqual(
      new Set(result.rootStatistics.map((candidate) => candidate.move)),
      new Set(["up", "down", "left", "right"]),
    );
    assert.ok(result.rootStatistics.every((candidate) => candidate.meanValue === -1));
    assert.ok(result.rootStatistics.every((candidate) => candidate.forcedLossRate === 1));
  });

  it("searches Standard positions with two, three, or four living snakes", () => {
    const rivals = [
      opponent("one", [
        { x: 8, y: 8 }, { x: 8, y: 7 }, { x: 8, y: 6 },
      ]),
      opponent("two", [
        { x: 2, y: 8 }, { x: 2, y: 7 }, { x: 2, y: 6 },
      ]),
      opponent("three", [
        { x: 8, y: 2 }, { x: 8, y: 1 }, { x: 8, y: 0 },
      ]),
    ];

    for (let opponentCount = 1; opponentCount <= 3; opponentCount += 1) {
      const state = gameState({ opponents: rivals.slice(0, opponentCount) });
      const result = searchMove(
        state,
        chooseStaticMove(state).move,
        undefined,
        {
          timeBudgetMs: 1_000,
          maxIterations: 16,
          maxTreeDepth: 2,
          rolloutDepth: 1,
          seed: 100 + opponentCount,
          now: () => 0,
        },
      );

      assert.equal(result.usedSearch, true);
      assert.equal(result.iterations, 16);
    }
  });

  it("keeps a 100 ms reserve from the external game timeout", () => {
    assert.equal(defaultSearchBudgetMs(SEARCH_STATE), 150);
    const shortTimeout = {
      ...SEARCH_STATE,
      game: { ...SEARCH_STATE.game, timeout: 80 },
    };
    assert.equal(defaultSearchBudgetMs(shortTimeout), 0);
  });

  it("accepts bounded runtime budget and response-reserve overrides", () => {
    const previousBudget = process.env.SEARCH_TIME_BUDGET_MS;
    const previousReserve = process.env.SEARCH_RESPONSE_RESERVE_MS;
    process.env.SEARCH_TIME_BUDGET_MS = "75";
    process.env.SEARCH_RESPONSE_RESERVE_MS = "150";
    try {
      assert.equal(defaultSearchBudgetMs(SEARCH_STATE), 75);
      const shortTimeout = {
        ...SEARCH_STATE,
        game: { ...SEARCH_STATE.game, timeout: 200 },
      };
      assert.equal(defaultSearchBudgetMs(shortTimeout), 50);
    } finally {
      if (previousBudget === undefined) {
        delete process.env.SEARCH_TIME_BUDGET_MS;
      } else {
        process.env.SEARCH_TIME_BUDGET_MS = previousBudget;
      }
      if (previousReserve === undefined) {
        delete process.env.SEARCH_RESPONSE_RESERVE_MS;
      } else {
        process.env.SEARCH_RESPONSE_RESERVE_MS = previousReserve;
      }
    }
  });

  it("rejects invalid search limits", () => {
    assert.throws(
      () =>
        searchMove(SEARCH_STATE, fallbackMove(), undefined, {
          maxIterations: -1,
        }),
      /maxIterations must be a non-negative integer/,
    );
    assert.throws(
      () =>
        searchMove(SEARCH_STATE, fallbackMove(), undefined, {
          eliminationProgressBonus: 1.1,
        }),
      /eliminationProgressBonus must be between zero and one/,
    );
    assert.throws(
      () =>
        searchMove(SEARCH_STATE, fallbackMove(), undefined, {
          rootMoveConstraint: "left",
          rootMoveConstraintIterations: 0,
        }),
      /rootMoveConstraintIterations must be a positive integer/,
    );
    assert.throws(
      () =>
        searchMove(SEARCH_STATE, fallbackMove(), undefined, {
          rootPolicyPrior: { left: Number.NaN },
        }),
      /rootPolicyPrior.left must be a finite non-negative number/,
    );
    assert.throws(
      () =>
        searchMove(SEARCH_STATE, fallbackMove(), undefined, {
          rootPolicyPrior: { down: 1 },
        }),
      /rootPolicyPrior must assign positive mass to a root move/,
    );
  });
});
