import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeFoodMotivation,
  foodMotivation,
} from "../src/evaluation/food-strategy.js";
import { gameState, opponent } from "./fixtures.js";

describe("strategic food motivation", () => {
  const openSpace = {
    foodDistance: 1,
    reachableCells: 100,
    enclosureRisk: "low" as const,
    boardArea: 121,
    occupiedCells: 6,
  };

  it("keeps a modest maintenance appetite without chasing the longest rival", () => {
    const farLongRival = opponent(
      "them",
      Array.from({ length: 73 }, (_, index) => ({
        x: index % 11,
        y: Math.floor(index / 11),
      })),
    );
    const state = gameState({ opponents: [farLongRival], health: 90 });
    const withRival = analyzeFoodMotivation(
      state.you,
      [farLongRival],
      { ...openSpace, occupiedCells: 76 },
    );
    const alone = analyzeFoodMotivation(state.you, [], openSpace);

    assert.ok(withRival.total > 0);
    assert.equal(withRival.tacticalOpportunity, 0);
    assert.equal(withRival.total, alone.total);
  });

  it("adds bounded duel catch-up without asking to surpass the rival", () => {
    const longer = opponent(
      "them",
      Array.from({ length: 20 }, (_, index) => ({
        x: 8 + (index % 2),
        y: Math.floor(index / 2),
      })),
    );
    const state = gameState({
      youBody: Array.from({ length: 12 }, (_, index) => ({
        x: 2 + (index % 2),
        y: Math.floor(index / 2),
      })),
      opponents: [longer],
      health: 90,
    });
    const behind = analyzeFoodMotivation(state.you, [longer], {
      ...openSpace,
      occupiedCells: 32,
    });
    const nearTarget = analyzeFoodMotivation(
      { ...state.you, length: 16, body: state.you.body.slice(0, 16) },
      [longer],
      { ...openSpace, occupiedCells: 36 },
    );

    assert.ok(behind.catchUpOpportunity > 0);
    assert.ok(behind.catchUpOpportunity <= 0.12);
    assert.equal(nearTarget.catchUpOpportunity, 0);
  });

  it("recognizes a small losing duel deficit without rewarding an existing lead", () => {
    const rival = opponent("them", [
      { x: 8, y: 5 }, { x: 8, y: 4 }, { x: 8, y: 3 }, { x: 8, y: 2 },
      { x: 8, y: 1 },
    ]);
    const behind = gameState({
      youBody: [
        { x: 5, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 3 }, { x: 5, y: 2 },
      ],
      opponents: [rival],
      health: 90,
    });
    const ahead = {
      ...behind.you,
      length: 6,
      body: [...behind.you.body, { x: 5, y: 1 }, { x: 5, y: 0 }],
    };

    const catchUp = analyzeFoodMotivation(behind.you, [rival], openSpace);
    const alreadyControls = analyzeFoodMotivation(ahead, [rival], openSpace);

    assert.ok(catchUp.catchUpOpportunity > 0);
    assert.ok(catchUp.catchUpOpportunity <= 0.12);
    assert.equal(alreadyControls.catchUpOpportunity, 0);
  });

  it("turns catch-up off when board occupancy or enclosure makes growth unsafe", () => {
    const longer = opponent("them", [
      { x: 8, y: 8 }, { x: 8, y: 7 }, { x: 8, y: 6 }, { x: 8, y: 5 },
      { x: 8, y: 4 }, { x: 8, y: 3 }, { x: 8, y: 2 }, { x: 8, y: 1 },
    ]);
    const state = gameState({ opponents: [longer], health: 90 });
    const occupied = analyzeFoodMotivation(state.you, [longer], {
      ...openSpace,
      occupiedCells: 73,
    });
    const critical = analyzeFoodMotivation(state.you, [longer], {
      ...openSpace,
      reachableCells: state.you.length,
      enclosureRisk: "critical",
    });

    assert.equal(occupied.catchUpOpportunity, 0);
    assert.ok(critical.catchUpOpportunity > 0);
    assert.equal(critical.tacticalAppetiteScale, 0);
    assert.equal(critical.total, critical.maintenanceAppetite * 0.65);
  });

  it("does not chase an irrecoverable length deficit", () => {
    const giant = opponent(
      "giant",
      Array.from({ length: 30 }, (_, index) => ({
        x: 8 + (index % 2),
        y: Math.floor(index / 2),
      })),
    );
    const state = gameState({ opponents: [giant], health: 90 });
    const analysis = analyzeFoodMotivation(state.you, [giant], openSpace);
    const controlledProgress = analyzeFoodMotivation(state.you, [giant], {
      ...openSpace,
      currentFoodDistance: 2,
      foodDistance: 1,
      foodRaceControl: 1,
      openExits: 3,
    });

    assert.equal(analysis.catchUpOpportunity, 0);
    assert.equal(analysis.total, analysis.maintenanceAppetite);
    assert.equal(controlledProgress.safeGrowthConversion, 0);
    assert.equal(controlledProgress.total, controlledProgress.maintenanceAppetite);
  });

  it("adds tactical growth only for a nearby equal-length matchup", () => {
    const nearbyEqual = opponent("nearby", [
      { x: 7, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 3 },
    ]);
    const farEqual = opponent("far", [
      { x: 10, y: 10 }, { x: 10, y: 9 }, { x: 10, y: 8 },
    ]);
    const state = gameState({ opponents: [nearbyEqual], health: 90 });
    const nearby = analyzeFoodMotivation(state.you, [nearbyEqual], openSpace);
    const far = analyzeFoodMotivation(state.you, [farEqual], openSpace);

    assert.ok(nearby.tacticalOpportunity > 0);
    assert.equal(far.tacticalOpportunity, 0);
    assert.ok(nearby.total > far.total);
  });

  it("keeps most maintenance eating while limiting tactical growth in cramped space", () => {
    const state = gameState({ health: 90 });
    const open = analyzeFoodMotivation(state.you, [], openSpace);
    const cramped = analyzeFoodMotivation(state.you, [], {
      foodDistance: 1,
      reachableCells: state.you.length + 1,
      enclosureRisk: "high",
    });

    assert.ok(cramped.total > 0);
    assert.ok(cramped.total < open.total);
    assert.equal(cramped.maintenanceAppetiteScale, 0.65);
    assert.equal(cramped.tacticalAppetiteScale, 0);
    assert.ok(cramped.total >= open.total * 0.65);
    assert.ok(cramped.spaceCapacity < open.spaceCapacity);
  });

  it("lets urgent health needs override cramped-space growth costs", () => {
    const longer = opponent("them", [
      { x: 8, y: 8 }, { x: 8, y: 7 }, { x: 8, y: 6 }, { x: 8, y: 5 },
    ]);
    const state = gameState({ opponents: [longer], health: 20 });
    const open = foodMotivation(state.you, [longer], openSpace);
    const cramped = foodMotivation(state.you, [longer], {
      foodDistance: 1,
      reachableCells: state.you.length,
      enclosureRisk: "critical",
    });

    assert.ok(Math.abs(open - 50 / 70) < 1e-12);
    assert.equal(cramped, open);
  });

  it("starts seeking food earlier when the nearest survivable route is long", () => {
    const state = gameState({ health: 60 });
    const nearby = analyzeFoodMotivation(state.you, [], {
      ...openSpace,
      foodDistance: 1,
    });
    const distant = analyzeFoodMotivation(state.you, [], {
      ...openSpace,
      foodDistance: 30,
    });

    assert.ok(distant.healthUrgency > nearby.healthUrgency);
    assert.ok(distant.total > nearby.total);
  });

  it("rewards only controlled, spacious progress toward tactical growth", () => {
    const longer = opponent("them", [
      { x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 },
      { x: 9, y: 6 }, { x: 9, y: 5 }, { x: 9, y: 4 },
    ]);
    const state = gameState({ opponents: [longer], health: 90 });
    const candidate = {
      ...openSpace,
      currentFoodDistance: 2,
      foodDistance: 1,
      foodRaceControl: 1,
      openExits: 3,
    };
    const controlled = analyzeFoodMotivation(
      state.you,
      [longer],
      candidate,
    );
    const contested = analyzeFoodMotivation(state.you, [longer], {
      ...candidate,
      foodRaceControl: 0,
    });
    const noProgress = analyzeFoodMotivation(state.you, [longer], {
      ...candidate,
      currentFoodDistance: 1,
    });
    const noExit = analyzeFoodMotivation(state.you, [longer], {
      ...candidate,
      openExits: 0,
    });

    assert.ok(controlled.safeGrowthConversion > 0);
    assert.equal(contested.safeGrowthConversion, 0);
    assert.equal(noProgress.safeGrowthConversion, 0);
    assert.equal(noExit.safeGrowthConversion, 0);
  });

  it("returns tactical growth priority to aggression after gaining length control", () => {
    const shorter = opponent("them", [
      { x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 },
    ]);
    const state = gameState({
      youBody: [
        { x: 5, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 3 }, { x: 5, y: 2 },
      ],
      opponents: [shorter],
      health: 90,
    });
    const analysis = analyzeFoodMotivation(state.you, [shorter], {
      ...openSpace,
      currentFoodDistance: 2,
      foodDistance: 1,
      foodRaceControl: 1,
      openExits: 3,
    });

    assert.equal(analysis.safeGrowthConversion, 0);
    assert.ok(analysis.total > 0, "ordinary maintenance appetite must remain");
  });
});
