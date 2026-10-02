import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeSpatialMove,
  healthAfterMove,
  projectOurMove,
} from "../src/evaluation/spatial-analysis.js";
import { gameState, opponent } from "./fixtures.js";

describe("healthAfterMove", () => {
  it("applies movement and hazard damage", () => {
    const state = gameState({
      health: 20,
      hazards: [{ x: 5, y: 6 }],
    });

    assert.equal(healthAfterMove(state, { x: 5, y: 6 }), 5);
  });

  it("restores health when food and hazard share the destination", () => {
    const destination = { x: 5, y: 6 };
    const state = gameState({
      health: 1,
      food: [destination],
      hazards: [destination],
    });

    assert.equal(healthAfterMove(state, destination), 100);
  });
});

describe("analyzeSpatialMove", () => {
  it("pops the old tail before duplicating the post-move tail when eating", () => {
    const state = gameState({
      youBody: [
        { x: 5, y: 5 },
        { x: 5, y: 4 },
        { x: 4, y: 4 },
      ],
      food: [{ x: 6, y: 5 }],
    });
    const projection = projectOurMove(state, "right");

    assert.deepEqual(projection.snake.body, [
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 4 },
    ]);
    assert.equal(projection.snake.length, 4);
  });

  it("distinguishes a large region from a small region behind a doorway", () => {
    const state = gameState({
      width: 7,
      height: 5,
      youBody: [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 2 },
      ],
      opponents: [
        opponent("top-wall", [
          { x: 2, y: 4 },
          { x: 2, y: 3 },
          { x: 2, y: 3 },
        ]),
        opponent("bottom-wall", [
          { x: 2, y: 0 },
          { x: 2, y: 1 },
          { x: 2, y: 1 },
        ]),
      ],
    });

    const left = analyzeSpatialMove(state, "left");
    const right = analyzeSpatialMove(state, "right");

    assert.ok(right.trap.reachableCells > left.trap.reachableCells);
    assert.equal(left.trap.reachableCells, 10);
    assert.equal(right.trap.reachableCells, 20);
    assert.equal(right.trap.hasEnoughSpace, true);
  });

  it("reports BFS food and tail access from the projected body", () => {
    const state = gameState({
      width: 5,
      height: 5,
      food: [{ x: 4, y: 2 }],
      youBody: [
        { x: 2, y: 2 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
      opponents: [opponent("them", [{ x: 0, y: 4 }])],
    });

    const analysis = analyzeSpatialMove(state, "right");

    assert.equal(analysis.safeFoodDistance, 1);
    assert.ok(analysis.tailDistance !== undefined);
    assert.ok(analysis.ownedTerritory > 0);
  });
});
