import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeTerritory,
  bodyReleaseTurns,
  blendedTerritoryAdvantage,
  territoryCount,
} from "../src/evaluation/territory.js";
import { gameState, opponent } from "./fixtures.js";

describe("analyzeTerritory", () => {
  it("delays duplicated tails and deep body segments by their release turn", () => {
    const state = gameState({
      youBody: [
        { x: 2, y: 2 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 1 },
      ],
      opponents: [opponent("them", [{ x: 4, y: 4 }])],
    });
    const release = bodyReleaseTurns(state);

    assert.equal(release.get("2,2"), 4);
    assert.equal(release.get("2,1"), 3);
    assert.equal(release.get("1,1"), 2);
    assert.equal(release.get("4,4"), 1);
  });

  it("splits an open lane by BFS distance and leaves the midpoint contested", () => {
    const state = gameState({
      width: 5,
      height: 1,
      youBody: [{ x: 0, y: 0 }],
      opponents: [opponent("them", [{ x: 4, y: 0 }])],
    });
    const result = analyzeTerritory(state);

    assert.equal(territoryCount(result, "us"), 2);
    assert.equal(territoryCount(result, "them"), 2);
    assert.deepEqual([...result.contested], ["2,0"]);
  });

  it("marks cells sealed by a complete wall as unreachable", () => {
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [{ x: 0, y: 1 }],
      opponents: [opponent("them", [{ x: 2, y: 1 }])],
    });
    const result = analyzeTerritory(
      state,
      new Set(["1,0", "1,1", "1,2"]),
    );

    assert.equal(territoryCount(result, "us"), 3);
    assert.equal(territoryCount(result, "them"), 3);
    assert.deepEqual(new Set(result.unreachable), new Set(["1,0", "1,1", "1,2"]));
  });

  it("awards an equidistant cell to the unique longest contender", () => {
    const state = gameState({
      width: 3,
      height: 1,
      youBody: [{ x: 0, y: 0 }],
      opponents: [
        opponent("them", [
          { x: 2, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 0 },
        ]),
      ],
    });
    const result = analyzeTerritory(state);

    assert.ok(!result.contested.has("1,0"));
    assert.equal(result.ownerByCell.get("1,0"), "them");
  });

  it("dampens ownership created only by a temporary body wall", () => {
    const state = gameState({
      width: 7,
      height: 5,
      youBody: [{ x: 1, y: 2 }],
      opponents: [opponent("them", [{ x: 5, y: 2 }])],
    });
    const wall = new Set(["4,0", "4,1", "4,2", "4,3", "4,4"]);
    const constrained = analyzeTerritory(state, wall);
    const constrainedDifference = territoryCount(constrained, "us") -
      territoryCount(constrained, "them");
    const blended = blendedTerritoryAdvantage(state, "us", wall);

    assert.ok(Math.abs(blended) < Math.abs(constrainedDifference / 35));
  });
});
