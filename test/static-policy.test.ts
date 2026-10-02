import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseStaticMove } from "../src/strategy/static-policy.js";
import { gameState, opponent } from "./fixtures.js";

describe("static fallback policy", () => {
  it("prefers the larger side of a partitioned board", () => {
    const state = gameState({
      width: 7,
      height: 5,
      youBody: [
        { x: 2, y: 2 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
      opponents: [
        opponent("top-wall", [
          { x: 2, y: 4 },
          { x: 2, y: 3 },
          { x: 1, y: 3 },
        ]),
        opponent("bottom-wall", [{ x: 2, y: 0 }]),
      ],
    });

    assert.equal(chooseStaticMove(state).move, "right");
  });

  it("does not enter a hazard that would exhaust its health", () => {
    const state = gameState({
      health: 10,
      hazards: [{ x: 5, y: 6 }],
    });

    assert.notEqual(chooseStaticMove(state).move, "up");
  });

  it("keeps the critical food route when fallback protection is used", () => {
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

    assert.equal(chooseStaticMove(state).move, "left");
  });
});
