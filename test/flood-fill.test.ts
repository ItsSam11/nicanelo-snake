import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { floodFill, relativeSpace } from "../src/evaluation/flood-fill.js";

describe("floodFill", () => {
  it("reaches every cell on an open board", () => {
    const result = floodFill({ x: 1, y: 1 }, 3, 3, new Set());

    assert.equal(result.size, 9);
    assert.equal(result.maxDepth, 2);
    assert.equal(result.distances.get("0,0"), 2);
  });

  it("does not cross a complete body wall", () => {
    const blocked = new Set(["1,0", "1,1", "1,2"]);
    const result = floodFill({ x: 0, y: 1 }, 3, 3, blocked);

    assert.equal(result.size, 3);
    assert.ok(result.reachable.has("0,2"));
    assert.ok(!result.reachable.has("2,1"));
  });

  it("allows an occupied origin because snake heads occupy their start", () => {
    const result = floodFill({ x: 0, y: 0 }, 2, 2, new Set(["0,0"]));

    assert.equal(result.size, 4);
  });

  it("returns an empty result for an origin outside the board", () => {
    const result = floodFill({ x: -1, y: 0 }, 3, 3, new Set());

    assert.equal(result.size, 0);
    assert.equal(result.maxDepth, 0);
  });
});

describe("relativeSpace", () => {
  it("compares reachable area with snake length", () => {
    assert.equal(relativeSpace(12, 4), 3);
    assert.equal(relativeSpace(12, 0), 0);
  });
});
