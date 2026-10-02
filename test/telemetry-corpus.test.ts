import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Battlesnake, Direction, GameState } from "../src/api/types.js";
import {
  officialReplaysFromTelemetry,
  parseTelemetryRecord,
} from "../src/training/telemetry-corpus.js";
import { validateChampionshipReplay } from "../src/training/replay-corpus.js";
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

function atTurn(state: GameState, turn: number, snakes: Battlesnake[]): GameState {
  return {
    ...state,
    turn,
    board: { ...state.board, snakes },
    you: snakes.find((snake) => snake.id === "us") ?? snakes[0] ?? state.you,
  };
}

function telemetry(event: "game_start" | "move" | "game_end", state: GameState) {
  return parseTelemetryRecord({
    schemaVersion: 1,
    eventId: `${event}-${state.turn}`,
    event,
    recordedAt: new Date(Date.UTC(2026, 8, 16, 0, 0, state.turn)).toISOString(),
    modelVersion: "test",
    gameId: state.game.id,
    turn: state.turn,
    ruleset: state.game.ruleset.name,
    map: state.game.map,
    state,
  });
}

describe("persisted telemetry corpus", () => {
  it("reconstructs a complete four-snake replay and skips incomplete games", () => {
    const initial = gameState({
      youBody: [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }],
      opponents: [
        opponent("a", [{ x: 9, y: 9 }, { x: 9, y: 10 }, { x: 10, y: 10 }]),
        opponent("b", [{ x: 1, y: 9 }, { x: 1, y: 10 }, { x: 0, y: 10 }]),
        opponent("c", [{ x: 9, y: 1 }, { x: 9, y: 0 }, { x: 10, y: 0 }]),
      ],
    });
    const turnOneSnakes = [
      moved(initial.board.snakes[0]!, "right"),
      moved(initial.board.snakes[1]!, "left"),
      moved(initial.board.snakes[2]!, "down"),
      moved(initial.board.snakes[3]!, "up"),
    ];
    const turnOne = atTurn(initial, 11, turnOneSnakes);
    const final = atTurn(initial, 12, [moved(turnOneSnakes[0]!, "up")]);
    const incomplete = {
      ...initial,
      game: { ...initial.game, id: "incomplete" },
    };
    const replays = officialReplaysFromTelemetry([
      telemetry("game_start", initial),
      telemetry("move", turnOne),
      telemetry("game_end", final),
      telemetry("game_start", incomplete),
    ]);

    assert.equal(replays.length, 1);
    assert.equal(replays[0]?.result.winnerId, "us");
    assert.deepEqual(replays[0]?.states.map((state) => state.turn), [10, 11, 12]);
    validateChampionshipReplay(replays[0]!);
  });
});
