import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Direction } from "../src/api/types.js";
import { evaluateMove } from "../src/evaluation/evaluate-state.js";
import { DEFAULT_EVALUATION_WEIGHTS } from "../src/evaluation/weights.js";
import {
  analyzeRootSafety,
  arbitrateRootMove,
  type RootSafetyAnalysis,
} from "../src/search/root-safety-arbiter.js";
import {
  PersistentSearchPool,
  SearchCoordinator,
} from "../src/search/search-pool.js";
import { selectRootMoveStatistic } from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

function moveAssessment(
  state: ReturnType<typeof gameState>,
  move: Direction,
) {
  return analyzeRootSafety(state).assessments.find(
    (item) => item.move === move,
  );
}

/** R7 campaign seed 2027300024, game b70c67d6..., turn 241. */
export function r7Turn241State() {
  return gameState({
    width: 11,
    height: 11,
    health: 70,
    youBody: [
      { x: 9, y: 6 }, { x: 10, y: 6 }, { x: 10, y: 7 },
      { x: 10, y: 8 }, { x: 9, y: 8 }, { x: 8, y: 8 },
      { x: 8, y: 9 }, { x: 8, y: 10 }, { x: 7, y: 10 },
      { x: 7, y: 9 }, { x: 6, y: 9 }, { x: 6, y: 10 },
      { x: 5, y: 10 }, { x: 5, y: 9 },
    ],
    opponents: [
      {
        ...opponent("hobbs", [
          { x: 2, y: 3 }, { x: 2, y: 2 }, { x: 1, y: 2 },
          { x: 1, y: 3 }, { x: 1, y: 4 }, { x: 1, y: 5 },
          { x: 2, y: 5 }, { x: 2, y: 6 }, { x: 2, y: 7 },
          { x: 2, y: 8 }, { x: 3, y: 8 }, { x: 3, y: 7 },
          { x: 3, y: 6 }, { x: 3, y: 5 }, { x: 3, y: 4 },
          { x: 3, y: 3 },
        ]),
        health: 98,
      },
      {
        ...opponent("snork", [
          { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 5 },
          { x: 8, y: 6 }, { x: 8, y: 7 }, { x: 7, y: 7 },
          { x: 7, y: 6 }, { x: 7, y: 5 }, { x: 6, y: 5 },
          { x: 6, y: 6 }, { x: 6, y: 7 }, { x: 5, y: 7 },
          { x: 5, y: 6 }, { x: 5, y: 5 }, { x: 4, y: 5 },
        ]),
        health: 89,
      },
    ],
    food: [{ x: 9, y: 4 }],
  });
}

/** R7 campaign seed 2027300031, game 5a3a73f5..., turn 300. */
export function r7Turn300State() {
  return gameState({
    width: 11,
    height: 11,
    health: 82,
    youBody: [
      { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 0 },
      { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 3, y: 2 },
      { x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 },
      { x: 4, y: 3 }, { x: 4, y: 2 }, { x: 4, y: 1 },
      { x: 4, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 1 },
      { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 },
      { x: 4, y: 4 },
    ],
    opponents: [opponent("snork", [
      { x: 2, y: 6 }, { x: 1, y: 6 }, { x: 1, y: 5 },
      { x: 2, y: 5 }, { x: 3, y: 5 }, { x: 3, y: 4 },
      { x: 2, y: 4 }, { x: 1, y: 4 }, { x: 0, y: 4 },
      { x: 0, y: 5 }, { x: 0, y: 6 }, { x: 0, y: 7 },
      { x: 1, y: 7 }, { x: 2, y: 7 }, { x: 3, y: 7 },
      { x: 4, y: 7 }, { x: 5, y: 7 }, { x: 6, y: 7 },
      { x: 7, y: 7 }, { x: 7, y: 8 },
    ])],
    food: [{ x: 10, y: 10 }, { x: 0, y: 0 }],
  });
}

/** R7 campaign seed 2027320045, game 861671b2..., turn 205. */
export function r7Turn205State() {
  return gameState({
    width: 11,
    height: 11,
    health: 74,
    youBody: [
      { x: 10, y: 7 }, { x: 10, y: 6 }, { x: 9, y: 6 },
      { x: 8, y: 6 }, { x: 7, y: 6 }, { x: 6, y: 6 },
      { x: 5, y: 6 }, { x: 5, y: 7 }, { x: 4, y: 7 },
      { x: 3, y: 7 }, { x: 3, y: 8 }, { x: 3, y: 9 },
      { x: 3, y: 10 }, { x: 2, y: 10 }, { x: 2, y: 9 },
      { x: 1, y: 9 },
    ],
    opponents: [
      {
        ...opponent("devin", [
          { x: 6, y: 9 }, { x: 6, y: 10 }, { x: 7, y: 10 },
          { x: 8, y: 10 }, { x: 9, y: 10 }, { x: 10, y: 10 },
          { x: 10, y: 9 }, { x: 9, y: 9 }, { x: 9, y: 8 },
          { x: 8, y: 8 }, { x: 8, y: 9 }, { x: 7, y: 9 },
          { x: 7, y: 8 }, { x: 7, y: 7 }, { x: 8, y: 7 },
          { x: 9, y: 7 },
        ]),
        health: 77,
      },
      opponent("hobbs", [
        { x: 10, y: 3 }, { x: 10, y: 4 }, { x: 10, y: 5 },
        { x: 9, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 5 },
        { x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 },
        { x: 4, y: 6 }, { x: 3, y: 6 }, { x: 3, y: 5 },
        { x: 3, y: 4 }, { x: 2, y: 4 }, { x: 2, y: 3 },
      ]),
    ],
    food: [{ x: 10, y: 8 }, { x: 8, y: 0 }],
  });
}

/** Safety-arbiter campaign seed 2027300005, turn 264. */
export function safetyArbiterTurn264State() {
  return gameState({
    width: 11,
    height: 11,
    health: 87,
    youBody: [
      { x: 2, y: 8 }, { x: 2, y: 9 }, { x: 1, y: 9 },
      { x: 0, y: 9 }, { x: 0, y: 10 }, { x: 1, y: 10 },
      { x: 2, y: 10 }, { x: 3, y: 10 }, { x: 3, y: 9 },
      { x: 3, y: 8 }, { x: 3, y: 7 }, { x: 3, y: 6 },
      { x: 2, y: 6 }, { x: 1, y: 6 }, { x: 0, y: 6 },
      { x: 0, y: 5 }, { x: 1, y: 5 },
    ],
    opponents: [{
      ...opponent("snork", [
        { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 },
        { x: 4, y: 7 }, { x: 4, y: 8 }, { x: 4, y: 9 },
        { x: 4, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 9 },
        { x: 5, y: 8 }, { x: 5, y: 7 }, { x: 5, y: 6 },
        { x: 6, y: 6 }, { x: 6, y: 7 }, { x: 6, y: 8 },
        { x: 7, y: 8 }, { x: 7, y: 7 }, { x: 8, y: 7 },
        { x: 8, y: 6 },
      ]),
      health: 91,
    }],
    food: [{ x: 7, y: 5 }, { x: 5, y: 3 }],
  });
}

describe("deterministic root safety arbiter", () => {
  it("replays R7 turn 241 and rejects the avoidable zero-exit move", () => {
    const state = r7Turn241State();
    const analysis = analyzeRootSafety(state);
    const up = moveAssessment(state, "up");
    const down = moveAssessment(state, "down");
    const decision = arbitrateRootMove(analysis, "up", ["down"]);

    assert.equal(up?.exact, true);
    assert.equal(up?.worstCaseNextMoves, 0);
    assert.ok((down?.worstCaseNextMoves ?? 0) > 0);
    assert.equal(decision.move, "down");
    assert.equal(decision.overridden, true);
    assert.equal(decision.reason, "avoided-zero-exit-exposure");
  });

  it("replays R7 turn 205 and lets safety override the food fallback", () => {
    const state = r7Turn205State();
    const analysis = analyzeRootSafety(state);
    const up = moveAssessment(state, "up");
    const left = moveAssessment(state, "left");
    const decision = arbitrateRootMove(analysis, "up", ["left"]);

    assert.equal(up?.worstCaseNextMoves, 0);
    assert.ok((left?.worstCaseNextMoves ?? 0) > 0);
    assert.equal(decision.move, "left");
  });

  it("replays R7 turn 300 when every MCTS risk score is saturated", () => {
    const state = r7Turn300State();
    const analysis = analyzeRootSafety(state);
    const admissible = new Set(analysis.admissibleMoves);
    const statistics = [
      { move: "right" as const, visits: 1947, meanValue: -0.9995,
        outcomeCount: 32, forcedLossRate: 0.9995, riskAdjustedValue: -1 },
      { move: "up" as const, visits: 1629, meanValue: -0.9868,
        outcomeCount: 32, forcedLossRate: 0.9871, riskAdjustedValue: -1 },
      { move: "left" as const, visits: 1446, meanValue: -0.9995,
        outcomeCount: 32, forcedLossRate: 0.9993, riskAdjustedValue: -1 },
    ];
    const preferred = selectRootMoveStatistic(
      statistics.filter((item) => admissible.has(item.move)),
      state,
    );
    const decision = arbitrateRootMove(
      analysis,
      "right",
      preferred === undefined ? [] : [preferred.move],
    );

    assert.deepEqual(analysis.admissibleMoves, ["up", "left"]);
    assert.equal(preferred?.move, "up");
    assert.equal(decision.move, "up");
    assert.equal(decision.reason, "avoided-zero-exit-exposure");
  });

  it("guards the authoritative zero-budget fallback at the coordinator", async () => {
    const state = r7Turn205State();
    const pool = new PersistentSearchPool({ workerCount: 1 });
    const coordinator = new SearchCoordinator(pool);

    try {
      await coordinator.ready();
      assert.equal(chooseStaticMove(state).move, "up");

      const result = await coordinator.chooseMove(
        state,
        undefined,
        { timeBudgetMs: 0 },
      );

      assert.equal(result.diagnostics.fallbackMove, "up");
      assert.equal(result.diagnostics.move, "left");
      assert.equal(result.response.move, "left");
      assert.equal(result.diagnostics.rootSafety?.overridden, true);
      assert.equal(
        result.diagnostics.rootSafety?.reason,
        "avoided-zero-exit-exposure",
      );
    } finally {
      await coordinator.close();
    }
  });

  it("can reproduce the unchanged R7 fallback for a paired ablation", async () => {
    const state = r7Turn205State();
    const pool = new PersistentSearchPool({ workerCount: 1 });
    const coordinator = new SearchCoordinator(pool);

    try {
      await coordinator.ready();
      const result = await coordinator.chooseMove(
        state,
        undefined,
        { timeBudgetMs: 0, rootSafetyArbiter: false },
      );

      assert.equal(result.diagnostics.fallbackMove, "up");
      assert.equal(result.response.move, "up");
      assert.equal(result.diagnostics.rootSafety, undefined);
    } finally {
      await coordinator.close();
    }
  });

  it("keeps the least-bad policy choice when every candidate is exposed", () => {
    const analysis: RootSafetyAnalysis = {
      applicable: true,
      assessments: [
        {
          move: "up",
          physicallyViable: true,
          exact: true,
          replyScenarios: 4,
          zeroContinuationReplies: 4,
          immediateNonWinReplies: 0,
          zeroNextMoveReplies: 4,
          terminalWinReplies: 0,
          worstCaseNextMoves: 0,
        },
        {
          move: "left",
          physicallyViable: true,
          exact: true,
          replyScenarios: 4,
          zeroContinuationReplies: 4,
          immediateNonWinReplies: 0,
          zeroNextMoveReplies: 4,
          terminalWinReplies: 0,
          worstCaseNextMoves: 0,
        },
      ],
      admissibleMoves: ["up", "left"],
    };

    const decision = arbitrateRootMove(analysis, "up", ["left"]);

    assert.equal(decision.move, "up");
    assert.equal(decision.overridden, false);
    assert.equal(decision.reason, "all-candidates-exposed");
  });

  it("does not turn a strictly winning head-to-head into passivity", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 2 }, { x: 3, y: 1 },
        { x: 3, y: 0 }, { x: 2, y: 0 },
      ],
      opponents: [opponent("shorter", [
        { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 1, y: 2 },
      ])],
      food: [{ x: 3, y: 3 }],
    });
    const analysis = analyzeRootSafety(state);
    const decision = arbitrateRootMove(
      analysis,
      "up",
      ["right"],
      {
        branchingReserve: {
          state,
          weights: DEFAULT_EVALUATION_WEIGHTS,
        },
      },
    );

    assert.equal(decision.move, "up");
    assert.equal(decision.overridden, false);
  });

  it("replays turn 264 and preserves branching before the trap becomes forced", () => {
    const state = safetyArbiterTurn264State();
    const analysis = analyzeRootSafety(state);
    const down = moveAssessment(state, "down");
    const left = moveAssessment(state, "left");
    const unchanged = arbitrateRootMove(analysis, "down", ["down", "left"]);
    const decision = arbitrateRootMove(
      analysis,
      "down",
      ["down", "left"],
      {
        branchingReserve: {
          state,
          weights: DEFAULT_EVALUATION_WEIGHTS,
        },
      },
    );

    assert.equal(down?.worstCaseNextMoves, 1);
    assert.equal(left?.worstCaseNextMoves, 2);
    assert.equal(unchanged.move, "down");
    assert.equal(unchanged.reason, "accepted");
    assert.equal(decision.move, "left");
    assert.equal(decision.overridden, true);
    assert.equal(decision.reason, "avoided-low-slack-bottleneck");
    assert.ok(
      evaluateMove(state, "left").total > evaluateMove(state, "down").total,
    );
    assert.ok(
      evaluateMove(state, "left").tacticalIntent.foodProgress >=
        evaluateMove(state, "down").tacticalIntent.foodProgress,
    );
  });

  it("reports a contested equal head as immediate non-win exposure, not a self-trap", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 2 }, { x: 3, y: 1 }, { x: 3, y: 0 },
      ],
      opponents: [opponent("equal", [
        { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 1, y: 2 },
      ])],
      food: [{ x: 3, y: 3 }],
    });
    const analysis = analyzeRootSafety(state);
    const decision = arbitrateRootMove(analysis, "up", ["right"]);

    assert.equal(decision.move, "right");
    assert.equal(decision.reason, "avoided-immediate-nonwin-exposure");
    assert.ok(decision.proposedImmediateNonWinReplies > 0);
    assert.equal(decision.proposedZeroNextMoveReplies, 0);
  });

  it("treats an all-replies terminal win as safe without a following exit", () => {
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [{ x: 0, y: 0 }],
      opponents: [opponent("trapped", [
        { x: 2, y: 2 }, { x: 1, y: 2 },
        { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 1 },
      ])],
    });
    const analysis = analyzeRootSafety(state);
    const right = analysis.assessments.find((item) => item.move === "right");
    const decision = arbitrateRootMove(analysis, "right", ["up"]);

    assert.equal(right?.terminalWinReplies, 4);
    assert.equal(right?.worstCaseNextMoves, 4);
    assert.equal(decision.move, "right");
    assert.equal(decision.reason, "accepted");
  });
});
