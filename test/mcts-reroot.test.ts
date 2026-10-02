import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MctsMemory,
  searchMove,
} from "../src/search/mcts.js";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

function behaviorContext(aggression: number) {
  return {
    scores: {
      aggression,
      resourceAcquisition: 0.5,
      healthManagement: 0.5,
      conservatism: 0.5,
    },
    opportunities: {
      aggression: 8,
      resourceAcquisition: 0,
      healthManagement: 0,
      conservatism: 0,
    },
    confidence: {
      aggression: 1,
      resourceAcquisition: 0,
      healthManagement: 0,
      conservatism: 0,
      overall: 0.25,
    },
    decisionsObserved: 8,
    decisionDenseTurns: 8,
    decisionDensity: 1,
  };
}

describe("MCTS tree re-rooting", () => {
  it("reuses and discounts a tree when opponent context changes", () => {
    const rival = opponent("them", [
      { x: 8, y: 8 },
      { x: 8, y: 7 },
      { x: 8, y: 6 },
    ]);
    const state = gameState({ opponents: [rival] });
    const memory = new MctsMemory();
    const common = {
      timeBudgetMs: 1_000,
      maxTreeDepth: 4,
      rolloutDepth: 2,
      seed: 31,
      now: () => 0,
    } as const;

    const first = searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        ...common,
        maxIterations: 16,
        opponentContexts: { [rival.id]: behaviorContext(0) },
      },
      memory,
    );
    const continued = searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        ...common,
        maxIterations: 1,
        opponentContexts: { [rival.id]: behaviorContext(1) },
      },
      memory,
    );

    assert.equal(first.iterations, 16);
    assert.equal(continued.reusedTree, true);
    assert.equal(continued.priorVisits, 8);

    const discardMemory = new MctsMemory();
    searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        ...common,
        maxIterations: 4,
        reuseTreeAcrossOpponentContexts: false,
        opponentContexts: { [rival.id]: behaviorContext(0) },
      },
      discardMemory,
    );
    const discarded = searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        ...common,
        maxIterations: 1,
        reuseTreeAcrossOpponentContexts: false,
        opponentContexts: { [rival.id]: behaviorContext(1) },
      },
      discardMemory,
    );
    assert.equal(discarded.reusedTree, false);
    assert.equal(discarded.priorVisits, 0);
  });

  it("requires fresh evidence after reused root statistics decay to zero", () => {
    const rival = opponent("them", [
      { x: 8, y: 8 },
      { x: 8, y: 7 },
      { x: 8, y: 6 },
    ]);
    const state = gameState({ opponents: [rival] });
    const memory = new MctsMemory();
    const common = {
      timeBudgetMs: 1_000,
      maxTreeDepth: 4,
      rolloutDepth: 1,
      treeReuseContextDecay: 0,
      seed: 32,
      now: () => 0,
    } as const;

    const first = searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        ...common,
        maxIterations: 8,
        opponentContexts: { [rival.id]: behaviorContext(0) },
      },
      memory,
    );
    const decayed = searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        ...common,
        maxIterations: 1,
        opponentContexts: { [rival.id]: behaviorContext(1) },
      },
      memory,
    );

    assert.equal(first.usedSearch, true);
    assert.equal(decayed.reusedTree, true);
    assert.equal(decayed.priorVisits, 0);
    assert.equal(decayed.usedSearch, false);
    assert.equal(
      decayed.rootStatistics.filter((item) => item.visits > 0).length,
      1,
    );
  });

  it("continues from a sampled child when the next observed turn matches", () => {
    const rival = {
      ...opponent("them", [
        { x: 2, y: 1 },
        { x: 2, y: 0 },
      ]),
      health: 10,
    };
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      opponents: [rival],
      food: [{ x: 0, y: 2 }],
      hazards: [
        { x: 2, y: 2 },
        { x: 2, y: 0 },
      ],
      health: 20,
    });
    const memory = new MctsMemory();

    searchMove(
      state,
      chooseStaticMove(state).move,
      undefined,
      {
        timeBudgetMs: 1_000,
        maxIterations: 16,
        maxTreeDepth: 4,
        rolloutDepth: 2,
        seed: 12,
        now: () => 0,
      },
      memory,
    );

    const stored = memory.games.get(state.game.id);
    const observed = stored?.root.actions
      .flatMap((action) => [...action.outcomes.values()])
      .map((node) => node.state)
      .find((candidate) =>
        candidate.board.snakes.length > 1 &&
        candidate.board.snakes.some((snake) => snake.id === state.you.id)
      );
    assert.notEqual(observed, undefined);
    const continued = searchMove(
      observed!,
      chooseStaticMove(observed!).move,
      undefined,
      {
        timeBudgetMs: 1_000,
        maxIterations: 1,
        maxTreeDepth: 4,
        rolloutDepth: 1,
        seed: 13,
        now: () => 0,
      },
      memory,
    );

    assert.equal(continued.reusedTree, true);
    assert.ok(continued.priorVisits > 0);
  });
});
