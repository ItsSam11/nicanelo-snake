import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGameOutcome } from "../src/domain/game-over.js";
import { gameState, opponent } from "./fixtures.js";

describe("getGameOutcome", () => {
  it("reports an ongoing game while multiple snakes remain", () => {
    const state = gameState({
      opponents: [opponent("them", [{ x: 8, y: 8 }])],
    });

    assert.deepEqual(getGameOutcome(state), {
      gameOver: false,
      result: "ongoing",
    });
  });

  it("reports a win when we are the final snake", () => {
    assert.deepEqual(getGameOutcome(gameState()), {
      gameOver: true,
      result: "win",
      winnerId: "us",
    });
  });

  it("reports a loss when an opponent is the final snake", () => {
    const state = gameState();
    state.board.snakes = [opponent("them", [{ x: 8, y: 8 }])];

    assert.deepEqual(getGameOutcome(state), {
      gameOver: true,
      result: "loss",
      winnerId: "them",
    });
  });

  it("reports a draw when every snake is eliminated", () => {
    const state = gameState();
    state.board.snakes = [];

    assert.deepEqual(getGameOutcome(state), {
      gameOver: true,
      result: "draw",
    });
  });
});
