import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateMove } from "../src/evaluation/evaluate-state.js";
import { analyzeSpatialMove } from "../src/evaluation/spatial-analysis.js";
import {
  ADVANTAGE_CONVERSION_BONUS,
  offensivePhaseBoost,
  offensiveSafetyValue,
  vulnerabilityValue,
} from "../src/evaluation/offense.js";
import { gameState, opponent } from "./fixtures.js";

describe("conditioned offensive analysis", () => {
  it("keeps moderate initiative only when a critical position has a short escape", () => {
    assert.equal(offensiveSafetyValue("critical", undefined), 0);
    assert.equal(offensiveSafetyValue("critical", 7), 0);
    assert.ok(offensiveSafetyValue("critical", 4) > 0);
    assert.equal(offensiveSafetyValue("critical", 1), 0.75);
  });

  it("applies bounded conversion boosts across four, three, and two snakes", () => {
    assert.equal(offensivePhaseBoost(4), 1);
    assert.equal(offensivePhaseBoost(3), 1.2);
    assert.equal(offensivePhaseBoost(2), 1.4);
  });

  it("uses a nearby tail to survive but does not attack from a critical pocket", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 5, y: 6 },
        { x: 5, y: 5 },
        { x: 4, y: 5 },
        { x: 3, y: 5 },
        { x: 2, y: 5 },
        { x: 2, y: 6 },
        { x: 3, y: 6 },
        { x: 4, y: 6 },
      ],
      opponents: [
        opponent("target", [
          { x: 5, y: 1 },
          { x: 4, y: 1 },
          { x: 4, y: 2 },
          { x: 5, y: 2 },
        ]),
      ],
    });
    const analysis = analyzeSpatialMove(state, "left");

    assert.equal(analysis.trap.enclosureRisk, "critical");
    assert.equal(analysis.tailDistance, 1);
    assert.ok(analysis.offense.postAttackSafety > 0);
    assert.ok(analysis.offense.postAttackSafety < 0.5);
    assert.equal(analysis.offense.tacticalIntent.safetyGate, false);
    assert.equal(analysis.offense.tacticalIntent.kind, "SURVIVE");
    assert.equal(analysis.offense.attackOpportunity, 0);
  });

  it("treats only a nearby rival tail as a credible escape", () => {
    assert.equal(vulnerabilityValue("critical", undefined), 1);
    assert.equal(vulnerabilityValue("critical", 1), 0.25);
    assert.equal(vulnerabilityValue("critical", 7), 1);
    assert.ok(
      vulnerabilityValue("critical", 4) >
        vulnerabilityValue("critical", 1),
    );
  });

  it("selects the rival pressured by our move instead of a global largest rival", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
      ],
      opponents: [
        opponent("target", [
          { x: 5, y: 3 },
          { x: 5, y: 2 },
          { x: 6, y: 2 },
        ]),
        opponent("largest", [
          { x: 1, y: 5 },
          { x: 1, y: 4 },
          { x: 1, y: 3 },
          { x: 0, y: 3 },
          { x: 0, y: 2 },
          { x: 0, y: 1 },
        ]),
      ],
    });
    const attack = analyzeSpatialMove(state, "right").offense;
    const retreat = analyzeSpatialMove(state, "left").offense;

    assert.equal(attack.targetId, "target");
    assert.notEqual(attack.targetId, "largest");
    assert.ok(attack.attackOpportunity > retreat.attackOpportunity);
    assert.ok(
      (attack.rivals.find((rival) => rival.opponentId === "target")
        ?.exitReduction ?? 0) > 0,
    );
  });

  it("recognizes when our body closes a doorway and removes rival space", () => {
    const state = gameState({
      width: 5,
      height: 5,
      youBody: [
        { x: 2, y: 1 },
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [
        opponent("target", [
          { x: 4, y: 2 },
          { x: 2, y: 3 },
          { x: 2, y: 4 },
          { x: 2, y: 4 },
        ]),
      ],
    });
    const closeDoor = analyzeSpatialMove(state, "up").offense;
    const leaveDoor = analyzeSpatialMove(state, "left").offense;
    const target = closeDoor.rivals.find(
      (rival) => rival.opponentId === "target",
    );

    assert.ok(target !== undefined);
    assert.equal(target.currentReachableCells, 20);
    assert.equal(target.projectedReachableCells, 10);
    assert.equal(target.spaceReduction, 0.5);
    assert.ok(closeDoor.attackOpportunity > leaveDoor.attackOpportunity);
  });

  it("separates favorable food control from a dangerous equal contest", () => {
    const favorable = gameState({
      youBody: [
        { x: 3, y: 5 },
        { x: 3, y: 4 },
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
      opponents: [
        opponent("shorter", [
          { x: 5, y: 5 },
          { x: 5, y: 4 },
          { x: 5, y: 3 },
        ]),
      ],
      food: [{ x: 4, y: 5 }],
    });
    const equal = gameState({
      youBody: favorable.you.body,
      opponents: [
        opponent("equal", [
          { x: 5, y: 5 },
          { x: 5, y: 4 },
          { x: 5, y: 3 },
          { x: 6, y: 3 },
        ]),
      ],
      food: [{ x: 4, y: 5 }],
    });
    const controlled = analyzeSpatialMove(favorable, "right").offense;
    const contested = analyzeSpatialMove(equal, "right").offense;

    assert.equal(controlled.foodControl, 1);
    assert.equal(controlled.foodContestRisk, 0);
    assert.equal(contested.foodControl, 0.35);
    assert.equal(contested.foodContestRisk, 0.8);
    assert.ok(
      evaluateMove(favorable, "right").features.foodAccess >
        evaluateMove(equal, "right").features.foodAccess,
    );
  });

  it("discounts an attack when an equal third snake can punish it", () => {
    const target = opponent("target", [
      { x: 5, y: 3 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
    const base = {
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
      ],
    };
    const isolated = analyzeSpatialMove(
      gameState({ ...base, opponents: [target] }),
      "right",
    ).offense;
    const exposed = analyzeSpatialMove(
      gameState({
        ...base,
        opponents: [
          target,
          opponent("third", [
            { x: 4, y: 5 },
            { x: 5, y: 5 },
            { x: 6, y: 5 },
            { x: 6, y: 4 },
          ]),
        ],
      }),
      "right",
    ).offense;

    assert.equal(isolated.thirdPartyExposure, 0);
    assert.equal(exposed.thirdPartyExposure, 1);
    assert.equal(isolated.strictLengthControl, true);
    assert.ok(isolated.advantageConversion > 0);
    assert.equal(exposed.advantageConversion, 0);
    assert.ok(exposed.attackOpportunity < isolated.attackOpportunity);
  });

  it("uses an independent third-party body to complete a safe pincer", () => {
    const state = gameState({
      width: 5,
      height: 5,
      youBody: [
        { x: 2, y: 1 },
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [
        opponent("target", [
          { x: 4, y: 2 },
          { x: 2, y: 3 },
          { x: 2, y: 4 },
          { x: 2, y: 4 },
        ]),
        opponent("third", [
          { x: 4, y: 3 },
          { x: 4, y: 4 },
          { x: 3, y: 4 },
          { x: 3, y: 3 },
        ]),
      ],
    });

    const intent = analyzeSpatialMove(state, "up").offense.tacticalIntent;

    assert.equal(intent.kind, "THIRD_PARTY_LEVERAGE");
    assert.equal(intent.targetId, "target");
    assert.ok(intent.scores.THIRD_PARTY_LEVERAGE > intent.scores.SPACE_DENIAL);
  });

  it("increases conversion pressure as the game advances toward a duel", () => {
    const target = opponent("target", [
      { x: 5, y: 3 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
    const distantOne = opponent("distant-1", [
      { x: 0, y: 6 },
      { x: 0, y: 5 },
      { x: 0, y: 4 },
    ]);
    const distantTwo = opponent("distant-2", [
      { x: 6, y: 6 },
      { x: 6, y: 5 },
      { x: 6, y: 4 },
    ]);
    const base = {
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
      ],
    };
    const multiplayer = analyzeSpatialMove(
      gameState({
        ...base,
        opponents: [target, distantOne, distantTwo],
      }),
      "right",
    ).offense.attackOpportunity;
    const threePlayer = analyzeSpatialMove(
      gameState({ ...base, opponents: [target, distantOne] }),
      "right",
    ).offense.attackOpportunity;
    const duel = analyzeSpatialMove(
      gameState({ ...base, opponents: [target] }),
      "right",
    ).offense.attackOpportunity;

    assert.ok(threePlayer > multiplayer);
    assert.ok(duel > threePlayer);
  });

  it("converts strict length control into one typed bounded pressure signal", () => {
    const state = gameState({
      width: 5,
      height: 5,
      youBody: [
        { x: 2, y: 1 },
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [
        opponent("target", [
          { x: 4, y: 2 },
          { x: 2, y: 3 },
          { x: 2, y: 4 },
          { x: 2, y: 4 },
        ]),
      ],
    });
    const offense = analyzeSpatialMove(state, "up").offense;

    assert.equal(offense.strictLengthControl, true);
    assert.ok(offense.constraintProgress > 0);
    assert.ok(offense.advantageConversion > 0);
    assert.ok(offense.attackOpportunity > offense.basePressure);
    assert.equal(offense.attackOpportunity, offense.tacticalIntent.score);
    assert.ok(
      offense.attackOpportunity >=
        offense.basePressure +
          ADVANTAGE_CONVERSION_BONUS * offense.advantageConversion,
    );
    assert.equal(
      evaluateMove(state, "up").features.opponentPressure,
      offense.attackOpportunity,
    );
  });

  it("does not convert equal length or an unsafe pocket into aggression", () => {
    const equal = gameState({
      width: 5,
      height: 5,
      youBody: [
        { x: 2, y: 1 },
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [
        opponent("target", [
          { x: 4, y: 2 },
          { x: 2, y: 3 },
          { x: 2, y: 4 },
          { x: 2, y: 4 },
        ]),
      ],
    });
    const equalOffense = analyzeSpatialMove(equal, "up").offense;
    assert.equal(equalOffense.strictLengthControl, false);
    assert.equal(equalOffense.advantageConversion, 0);
    assert.notEqual(equalOffense.tacticalIntent.kind, "FORCE_H2H");

    const sealed = gameState({
      width: 5,
      height: 4,
      youBody: [
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 1 },
        { x: 3, y: 2 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 3 },
      ],
      opponents: [
        opponent("target", [
          { x: 4, y: 1 },
          { x: 4, y: 2 },
          { x: 4, y: 3 },
        ]),
      ],
    });
    const unsafe = analyzeSpatialMove(sealed, "right");
    assert.equal(unsafe.offense.strictLengthControl, true);
    assert.equal(unsafe.trap.hasEnoughSpace, false);
    assert.equal(unsafe.offense.advantageConversion, 0);
    assert.equal(unsafe.offense.tacticalIntent.safetyGate, false);
    assert.equal(unsafe.offense.attackOpportunity, 0);
  });

  it("keeps food accounting orthogonal to length conversion", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 2, y: 1 },
      ],
      opponents: [
        opponent("shorter", [
          { x: 5, y: 3 },
          { x: 5, y: 2 },
          { x: 6, y: 2 },
        ]),
      ],
      food: [{ x: 4, y: 3 }],
    });
    const offense = analyzeSpatialMove(state, "right").offense;

    assert.equal(offense.foodControl, 1);
    assert.equal(offense.foodContestRisk, 0);
    assert.equal(offense.strictLengthControl, true);
    assert.ok(evaluateMove(state, "right").features.foodAccess > 0);
  });

  it("does not invent a length edge by eating contested food", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 2 },
        { x: 3, y: 1 },
        { x: 3, y: 0 },
      ],
      opponents: [
        opponent("equal", [
          { x: 2, y: 3 },
          { x: 1, y: 3 },
          { x: 1, y: 2 },
        ]),
      ],
      food: [{ x: 3, y: 3 }],
    });
    const offense = analyzeSpatialMove(state, "up").offense;

    assert.equal(offense.strictLengthControl, false);
    assert.equal(offense.advantageConversion, 0);
    assert.equal(offense.tacticalIntent.safetyGate, false);
    assert.equal(offense.attackOpportunity, 0);
  });

  it("labels a genuinely winning contested cell as FORCE_H2H", () => {
    const state = gameState({
      width: 7,
      height: 7,
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
    });

    const offense = analyzeSpatialMove(state, "right").offense;

    assert.equal(offense.tacticalIntent.kind, "FORCE_H2H");
    assert.equal(offense.tacticalIntent.targetId, "shorter");
    assert.equal(offense.tacticalIntent.safetyGate, true);
    assert.equal(offense.tacticalIntent.scores.FORCE_H2H, offense.attackOpportunity);
  });

  it("keeps a safe FORCE_H2H while a bounded catch-up route exists", () => {
    const state = gameState({
      width: 7,
      height: 7,
      youBody: [
        { x: 3, y: 3 }, { x: 3, y: 2 }, { x: 3, y: 1 },
        { x: 2, y: 1 }, { x: 2, y: 2 },
      ],
      opponents: [
        opponent("shorter", [
          { x: 5, y: 3 }, { x: 5, y: 2 },
          { x: 6, y: 2 }, { x: 6, y: 1 },
        ]),
        opponent("longest", [
          { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 6, y: 4 },
          { x: 5, y: 4 }, { x: 4, y: 4 }, { x: 3, y: 4 },
          { x: 2, y: 4 }, { x: 1, y: 4 },
        ]),
      ],
      food: [{ x: 1, y: 3 }],
    });

    const intent = analyzeSpatialMove(state, "right").offense.tacticalIntent;

    assert.equal(intent.strategicCatchUpRequired, true);
    assert.equal(intent.foodProgress, -1);
    assert.equal(intent.resourceGate, true);
    assert.equal(intent.kind, "FORCE_H2H");
    assert.equal(intent.targetId, "shorter");
  });

  it("turns urgent food progress into RECOVER and gates pressure away from it", () => {
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

    const recover = analyzeSpatialMove(state, "left").offense.tacticalIntent;
    const abandon = analyzeSpatialMove(state, "right").offense;

    assert.equal(recover.kind, "RECOVER");
    assert.equal(recover.resourceRequired, true);
    assert.equal(recover.resourceGate, true);
    assert.ok(recover.foodProgress > 0);
    assert.equal(abandon.tacticalIntent.resourceGate, false);
    assert.equal(abandon.attackOpportunity, 0);
  });

  it("treats safe catch-up food as RESOURCE_GROWTH before hunger", () => {
    const state = gameState({
      width: 7,
      height: 7,
      health: 90,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
      ],
      opponents: [opponent("longer", [
        { x: 6, y: 6 },
        { x: 6, y: 5 },
        { x: 6, y: 4 },
        { x: 6, y: 3 },
        { x: 5, y: 3 },
        { x: 5, y: 2 },
      ])],
      food: [{ x: 1, y: 3 }],
    });

    const intent = analyzeSpatialMove(state, "left").offense.tacticalIntent;

    assert.equal(intent.kind, "RESOURCE_GROWTH");
    assert.equal(intent.resourceRequired, true);
    assert.equal(intent.strategicCatchUpRequired, true);
    assert.ok(intent.foodProgress > 0);
  });

  it("does not mandate catch-up food that a longer rival reaches first", () => {
    const state = gameState({
      width: 7,
      height: 7,
      health: 90,
      youBody: [
        { x: 3, y: 3 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
      ],
      opponents: [opponent("longer", [
        { x: 1, y: 4 },
        { x: 1, y: 5 },
        { x: 2, y: 5 },
        { x: 3, y: 5 },
        { x: 4, y: 5 },
        { x: 5, y: 5 },
      ])],
      food: [{ x: 1, y: 3 }],
    });

    const intent = analyzeSpatialMove(state, "left").offense.tacticalIntent;

    assert.equal(intent.strategicCatchUpRequired, false);
    assert.equal(intent.resourceRequired, false);
    assert.equal(intent.scores.RESOURCE_GROWTH, 0);
    assert.notEqual(intent.kind, "RESOURCE_GROWTH");
  });
});
