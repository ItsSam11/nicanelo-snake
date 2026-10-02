import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Battlesnake, Direction, GameState } from "../src/api/types.js";
import {
  buildReplayCorpus,
  parseOfficialReplayJsonl,
  parseReplaySummary,
  validateChampionshipReplay,
} from "../src/training/replay-corpus.js";
import { gameState, opponent } from "./fixtures.js";

function moved(snake: Battlesnake, move: Direction, latency: string): Battlesnake {
  const offsets: Record<Direction, { x: number; y: number }> = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const offset = offsets[move];
  const head = {
    x: snake.head.x + offset.x,
    y: snake.head.y + offset.y,
  };
  const body = [head, ...snake.body.slice(0, -1)];
  return { ...snake, head, body, length: body.length, latency };
}

function withSnakes(
  state: GameState,
  turn: number,
  snakes: Battlesnake[],
): GameState {
  const you = snakes.find((snake) => snake.id === "us") ?? state.you;
  return {
    ...state,
    turn,
    board: { ...state.board, snakes },
    you,
  };
}

function replayText(initialSnakeCount = 4): string {
  const initial = gameState({
    youBody: [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 0 }],
    opponents: [
      opponent("a", [{ x: 9, y: 9 }, { x: 9, y: 10 }, { x: 9, y: 10 }]),
      opponent("b", [{ x: 1, y: 9 }, { x: 1, y: 10 }, { x: 1, y: 10 }]),
      opponent("c", [{ x: 9, y: 1 }, { x: 9, y: 0 }, { x: 9, y: 0 }]),
    ].slice(0, initialSnakeCount - 1),
  });
  const directions = ["right", "left", "down", "up"] as const;
  const turnOneSnakes = initial.board.snakes.map((snake, index) =>
    moved(snake, directions[index]!, String(20 + index * 2))
  );
  const turnOne = withSnakes(initial, 11, turnOneSnakes);
  const winner = moved(turnOneSnakes[0]!, "up", "30");
  const turnTwo = withSnakes(initial, 12, [winner]);

  return [
    initial.game,
    initial,
    turnOne,
    turnTwo,
    { winnerId: "us", winnerName: "us", isDraw: false },
  ].map((value) => JSON.stringify(value)).join("\n");
}

describe("official replay corpus", () => {
  it("extracts four-snake move labels, eliminations, and latency", () => {
    const replay = parseOfficialReplayJsonl(replayText());
    validateChampionshipReplay(replay);
    const corpus = buildReplayCorpus(replay);

    assert.equal(corpus.summary.initialSnakeCount, 4);
    assert.equal(corpus.summary.width, 11);
    assert.equal(corpus.summary.height, 11);
    assert.equal(corpus.summary.winnerId, "us");
    assert.equal(corpus.summary.schemaVersion, 2);
    assert.equal(corpus.summary.source, "gym");
    assert.equal(corpus.summary.coverage.kind, "full");
    assert.equal(corpus.summary.profiles.length, 4);
    const ourProfile = corpus.summary.profiles.find((item) =>
      item.snakeId === "us"
    );
    assert.equal(ourProfile?.profileVersion, "behavior-profile-v2");
    assert.equal(ourProfile?.metrics.decisionDensity >= 0, true);
    assert.equal("winner" in (ourProfile?.metrics ?? {}), false);
    assert.equal(corpus.summary.strategicAggression?.length, 4);
    assert.equal(
      corpus.summary.strategicAggression?.find((item) => item.snakeId === "us")
        ?.metricVersion,
      "post-length-advantage-v1",
    );
    assert.equal(corpus.summary.observedMoveCount, 5);
    assert.deepEqual(
      corpus.observations.slice(0, 4).map((item) => item.move),
      ["right", "left", "down", "up"],
    );
    assert.equal(corpus.observations[0]?.opponentsAlive, 3);
    assert.equal(
      corpus.observations[0]?.behaviorBeforeMove.decisionsObserved,
      0,
    );
    assert.equal(
      corpus.observations.at(-1)?.behaviorBeforeMove.decisionsObserved,
      1,
    );
    assert.equal(
      corpus.summary.eliminations.find((item) => item.snakeId === "a")
        ?.eliminatedOnTurn,
      12,
    );
    assert.equal(
      corpus.summary.latency.find((item) => item.snakeId === "us")?.p95Ms,
      30,
    );
    assert.deepEqual(
      parseReplaySummary(JSON.stringify(corpus.summary)).strategicAggression,
      corpus.summary.strategicAggression,
    );
  });

  it("keeps legacy v2 summaries readable and validates the additive metrics", () => {
    const summary = buildReplayCorpus(parseOfficialReplayJsonl(replayText())).summary;
    const legacy = { ...summary };
    delete legacy.strategicAggression;
    assert.equal(
      parseReplaySummary(JSON.stringify(legacy)).strategicAggression,
      undefined,
    );

    const malformed = {
      ...summary,
      strategicAggression: [{ metricVersion: "post-length-advantage-v1" }],
    };
    assert.throws(
      () => parseReplaySummary(JSON.stringify(malformed)),
      /Invalid game summary/,
    );
  });

  it("accepts replays that start with two, three, or four snakes", () => {
    for (const count of [2, 3, 4]) {
      const replay = parseOfficialReplayJsonl(replayText(count));
      assert.doesNotThrow(() => validateChampionshipReplay(replay));
      assert.equal(buildReplayCorpus(replay).summary.initialSnakeCount, count);
    }
  });

  it("rejects replays outside the supported two-to-four range", () => {
    const replay = parseOfficialReplayJsonl(replayText());
    const initial = replay.states[0]!;
    const extra = opponent("extra", [
      { x: 5, y: 9 },
      { x: 5, y: 10 },
      { x: 5, y: 10 },
    ]);

    for (const snakes of [
      initial.board.snakes.slice(0, 1),
      [...initial.board.snakes, extra],
    ]) {
      assert.throws(
        () => validateChampionshipReplay({
          ...replay,
          states: [{
            ...initial,
            board: { ...initial.board, snakes },
          }, ...replay.states.slice(1)],
        }),
        /between two and four initial snakes/,
      );
    }
  });

  it("rejects non-championship replays", () => {
    const replay = parseOfficialReplayJsonl(replayText());
    const invalid = {
      ...replay,
      metadata: {
        ...replay.metadata,
        ruleset: { ...replay.metadata.ruleset, name: "solo" },
      },
    };
    assert.throws(
      () => validateChampionshipReplay(invalid),
      /standard ruleset/,
    );
  });
});
