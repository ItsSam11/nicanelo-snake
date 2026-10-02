import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleStandardFoodSpawn } from "../src/domain/food-spawn.js";
import { coordinateKey } from "../src/domain/board.js";
import { gameState } from "./fixtures.js";

describe("Standard food spawning", () => {
  it("restores minimumFood before considering the random spawn chance", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
      ],
      food: [],
    });
    state.game.ruleset.settings.minimumFood = 3;
    state.game.ruleset.settings.foodSpawnChance = 0;

    const next = sampleStandardFoodSpawn(state, () => 0);

    assert.equal(state.board.food.length, 0, "the input state must stay immutable");
    assert.equal(next.board.food.length, 3);
  });

  it("uses foodSpawnChance only after the minimum is satisfied", () => {
    const state = gameState({ food: [{ x: 0, y: 0 }] });
    state.game.ruleset.settings.minimumFood = 1;
    state.game.ruleset.settings.foodSpawnChance = 25;
    const values = [0.76, 0];

    const spawned = sampleStandardFoodSpawn(
      state,
      () => values.shift() ?? 0,
    );
    const notSpawned = sampleStandardFoodSpawn(state, () => 0.75);

    assert.equal(spawned.board.food.length, 2);
    assert.equal(notSpawned.board.food.length, 1);
  });

  it("avoids food, bodies, and head-adjacent cells while allowing hazards", () => {
    const state = gameState({
      width: 3,
      height: 3,
      youBody: [{ x: 1, y: 1 }],
      food: [{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 0 }],
      hazards: [{ x: 2, y: 2 }],
    });
    state.game.ruleset.settings.minimumFood = 4;
    state.game.ruleset.settings.foodSpawnChance = 0;

    const next = sampleStandardFoodSpawn(state, () => 0);
    const foodKeys = new Set(next.board.food.map(coordinateKey));

    assert.equal(next.board.food.length, 4);
    assert.ok(foodKeys.has("2,2"), "Standard food may spawn in a hazard");
    assert.ok(!foodKeys.has("1,1"));
    assert.ok(!foodKeys.has("1,0"));
    assert.ok(!foodKeys.has("0,1"));
    assert.ok(!foodKeys.has("2,1"));
    assert.ok(!foodKeys.has("1,2"));
  });

  it("does not apply Standard-map spawning to other maps", () => {
    const state = gameState({ food: [] });
    state.game.map = "custom";
    state.game.ruleset.settings.minimumFood = 2;

    assert.equal(sampleStandardFoodSpawn(state, () => 0), state);
  });
});
