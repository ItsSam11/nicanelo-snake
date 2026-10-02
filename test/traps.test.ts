import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeTraps } from "../src/evaluation/traps.js";

describe("analyzeTraps", () => {
  it("identifies a corridor as a cul-de-sac with articulation bottlenecks", () => {
    const result = analyzeTraps({ x: 0, y: 0 }, 5, 1, new Set(), 2);

    assert.equal(result.reachableCells, 5);
    assert.equal(result.openExits, 1);
    assert.equal(result.isCulDeSac, true);
    assert.deepEqual(new Set(result.bottlenecks), new Set(["1,0", "2,0", "3,0"]));
    assert.deepEqual(new Set(result.deadEnds), new Set(["4,0"]));
    assert.equal(result.enclosureRisk, "high");
  });

  it("reports low risk in a roomy open region", () => {
    const result = analyzeTraps({ x: 1, y: 1 }, 3, 3, new Set(), 2);

    assert.equal(result.reachableCells, 9);
    assert.equal(result.openExits, 4);
    assert.equal(result.bottlenecks.size, 0);
    assert.equal(result.deadEnds.size, 0);
    assert.equal(result.enclosureRisk, "low");
  });

  it("reports critical risk when reachable space is smaller than the snake", () => {
    const result = analyzeTraps({ x: 1, y: 0 }, 3, 1, new Set(), 4);

    assert.equal(result.hasEnoughSpace, false);
    assert.equal(result.spaceMargin, -1);
    assert.equal(result.relativeSpace, 0.75);
    assert.equal(result.enclosureRisk, "critical");
  });
});
