import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Battlesnake,
  Direction,
  GameState,
} from "../src/api/types.js";
import {
  analyzeStrategicAggression,
  STRATEGIC_AGGRESSION_METRIC_VERSION,
  validStrategicAggressionSummaries,
} from "../src/training/strategic-aggression.js";
import type { OfficialReplay } from "../src/training/replay-corpus.js";
import { gameState, opponent } from "./fixtures.js";

function moved(snake: Battlesnake, move: Direction): Battlesnake {
  const offset = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  }[move];
  const head = { x: snake.head.x + offset.x, y: snake.head.y + offset.y };
  const body = [head, ...snake.body.slice(0, -1)];
  return { ...snake, head, body, length: body.length };
}

function atTurn(
  template: GameState,
  turn: number,
  snakes: Battlesnake[],
): GameState {
  return {
    ...template,
    turn,
    board: { ...template.board, snakes },
    you: snakes.find((snake) => snake.id === "us") ?? snakes[0] ?? template.you,
  };
}

function replay(states: GameState[], winnerId = ""): OfficialReplay {
  return {
    metadata: states[0]!.game,
    states,
    result: {
      winnerId,
      winnerName: winnerId,
      isDraw: winnerId.length === 0,
    },
  };
}

function ourSummary(
  source: OfficialReplay,
  observations: Array<{ turn: number; snakeId: string; move: Direction }>,
) {
  const summary = analyzeStrategicAggression(source, observations).find(
    (item) => item.snakeId === "us",
  );
  assert.ok(summary !== undefined);
  return summary;
}

function doorwayState(): GameState {
  return gameState({
    width: 5,
    height: 5,
    youBody: [
      { x: 2, y: 1 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 1 },
    ],
    opponents: [opponent("target", [
      { x: 4, y: 2 },
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ])],
    food: [{ x: 1, y: 1 }],
  });
}

describe("post-length-advantage strategic aggression", () => {
  it("measures selected pressure and projected constraint with separate denominators", () => {
    const before = doorwayState();
    const after = atTurn(before, before.turn + 1, [
      moved(before.you, "up"),
      moved(before.board.snakes[1]!, "down"),
    ]);
    const summary = ourSummary(replay([before, after]), [{
      turn: before.turn,
      snakeId: "us",
      move: "up",
    }]);

    assert.equal(summary.metricVersion, STRATEGIC_AGGRESSION_METRIC_VERSION);
    assert.deepEqual(summary.advantage, {
      observedTurns: 1,
      globalLeadTurns: 1,
      firstObservedTurn: 10,
    });
    assert.equal(summary.pressure.opportunityTurns, 1);
    assert.equal(summary.pressure.selectedTurns, 1);
    assert.equal(summary.pressure.meanChoiceScore, 1);
    assert.ok((summary.pressure.meanBasePressure ?? 0) > 0);
    assert.ok((summary.pressure.meanAdvantageConversion ?? 0) > 0);
    assert.equal(summary.traps.opportunityTurns, 1);
    assert.equal(summary.traps.projectedConstraintSelections, 1);
    assert.ok((summary.traps.meanChosenProgress ?? 0) > 0);
    assert.deepEqual(summary.eliminations, {
      opponentEliminationsWhileLeading: 0,
      opponentEliminationsWhileGloballyLeading: 0,
      associatedEliminations: 0,
    });
  });

  it("labels disappearances as associated rather than direct kill credit", () => {
    const before = doorwayState();
    const after = atTurn(before, before.turn + 1, [moved(before.you, "up")]);
    const summary = ourSummary(replay([before, after], "us"), [{
      turn: before.turn,
      snakeId: "us",
      move: "up",
    }]);

    assert.deepEqual(summary.eliminations, {
      opponentEliminationsWhileLeading: 1,
      opponentEliminationsWhileGloballyLeading: 1,
      associatedEliminations: 1,
    });
    assert.equal("directKills" in summary.eliminations, false);
  });

  it("counts favorable head-to-head offers without claiming a collision occurred", () => {
    const before = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
      ],
      opponents: [opponent("target", [
        { x: 5, y: 3 },
        { x: 5, y: 2 },
        { x: 6, y: 2 },
      ])],
    });
    const after = atTurn(before, before.turn + 1, [
      moved(before.you, "right"),
      moved(before.board.snakes[1]!, "up"),
    ]);
    const summary = ourSummary(replay([before, after]), [{
      turn: before.turn,
      snakeId: "us",
      move: "right",
    }]);

    assert.deepEqual(summary.favorableHeadToHead, {
      opportunityTurns: 1,
      offers: 1,
    });
    assert.equal(summary.eliminations.opponentEliminationsWhileLeading, 0);
  });

  it("requires a pre-move lead and never bridges a missing replay frame", () => {
    const equal = gameState({
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
      ],
      opponents: [opponent("equal", [
        { x: 5, y: 3 },
        { x: 5, y: 2 },
        { x: 6, y: 2 },
      ])],
      food: [{ x: 4, y: 3 }],
    });
    const equalAfter = atTurn(equal, equal.turn + 1, [
      moved(equal.you, "right"),
      moved(equal.board.snakes[1]!, "up"),
    ]);
    const equalSummary = ourSummary(replay([equal, equalAfter]), [{
      turn: equal.turn,
      snakeId: "us",
      move: "right",
    }]);
    assert.equal(equalSummary.advantage.observedTurns, 0);
    assert.equal(equalSummary.pressure.opportunityTurns, 0);

    const leading = doorwayState();
    const gap = atTurn(leading, leading.turn + 2, [
      moved(leading.you, "up"),
      moved(leading.board.snakes[1]!, "down"),
    ]);
    const gapSummary = ourSummary(replay([leading, gap]), [{
      turn: leading.turn,
      snakeId: "us",
      move: "up",
    }]);
    assert.equal(gapSummary.advantage.observedTurns, 0);
  });

  it("validates the additive metric shape and rejects inconsistent counts", () => {
    const before = doorwayState();
    const after = atTurn(before, before.turn + 1, [
      moved(before.you, "left"),
      moved(before.board.snakes[1]!, "down"),
    ]);
    const values = analyzeStrategicAggression(replay([before, after]), [{
      turn: before.turn,
      snakeId: "us",
      move: "left",
    }]);
    assert.equal(validStrategicAggressionSummaries(values), true);

    const invalid = structuredClone(values);
    invalid[0]!.pressure.selectedTurns = 2;
    invalid[0]!.pressure.opportunityTurns = 1;
    assert.equal(validStrategicAggressionSummaries(invalid), false);
  });
});
