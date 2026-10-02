import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  strategicRootPrior,
  type StrategicRootPriorCandidate,
} from "../src/search/strategic-root-prior.js";
import { resolveEvaluationWeights } from "../src/evaluation/weights.js";
import { gameState, opponent } from "./fixtures.js";

function candidate(
  candidates: readonly StrategicRootPriorCandidate[],
  move: StrategicRootPriorCandidate["move"],
): StrategicRootPriorCandidate {
  const found = candidates.find((item) => item.move === move);
  assert.ok(found !== undefined, `missing ${move} candidate`);
  return found;
}

const liveControlWeights = resolveEvaluationWeights({
  reachableSpace: 25,
  relativeSpace: 25,
  territory: 75,
  health: 10,
  foodAccess: 55,
  lengthAdvantage: 25,
  mobility: 35,
  headToHead: 90,
  opponentPressure: 54,
  hazardDistance: 10,
  wallDistance: 2.5,
  tailAccess: 10,
  trapSafety: 55,
});

describe("strategic root prior", () => {
  it("puts safe causal pressure ahead of an empty retreat", () => {
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
    const result = strategicRootPrior(state, ["up", "left"]);
    const attack = candidate(result.candidates, "up");
    const retreat = candidate(result.candidates, "left");

    assert.ok(attack.features.opponentPressure > retreat.features.opponentPressure);
    assert.ok(attack.probability > retreat.probability);
    assert.equal(attack.catastrophic, false);
  });

  it("lets the selected value model allocate more search to strategic control", () => {
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
    const baseline = strategicRootPrior(state, ["up", "left"]);
    const adaptive = strategicRootPrior(
      state,
      ["up", "left"],
      resolveEvaluationWeights({
        territory: 75,
        headToHead: 90,
        opponentPressure: 54,
      }),
    );

    assert.ok(
      candidate(adaptive.candidates, "up").probability >
        candidate(baseline.candidates, "up").probability,
    );
  });

  it("does not let territory turn a sealed pocket into an attractive attack", () => {
    const state = gameState({
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
    const result = strategicRootPrior(state, ["right", "left"]);
    const sealed = candidate(result.candidates, "right");
    const escape = candidate(result.candidates, "left");

    assert.equal(sealed.features.trapSafety, -1);
    assert.equal(sealed.catastrophic, true);
    assert.equal(escape.catastrophic, false);
    assert.ok(sealed.probability < 0.01);
    assert.ok(escape.probability > sealed.probability);
  });

  it("reduces attack priority when a third snake can punish the line", () => {
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
    const isolated = strategicRootPrior(
      gameState({ ...base, opponents: [target] }),
      ["right", "left"],
    );
    const exposed = strategicRootPrior(
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
      ["right", "left"],
    );

    assert.ok(
      candidate(isolated.candidates, "right").probability >
        candidate(exposed.candidates, "right").probability,
    );
  });

  it("distinguishes controlled food from an equal contested capture", () => {
    const youBody = [
      { x: 3, y: 5 },
      { x: 3, y: 4 },
      { x: 3, y: 3 },
      { x: 2, y: 3 },
    ];
    const controlled = strategicRootPrior(
      gameState({
        youBody,
        opponents: [opponent("shorter", [
          { x: 5, y: 5 },
          { x: 5, y: 4 },
          { x: 5, y: 3 },
        ])],
        food: [{ x: 4, y: 5 }],
      }),
      ["right", "left"],
    );
    const contested = strategicRootPrior(
      gameState({
        youBody,
        opponents: [opponent("equal", [
          { x: 5, y: 5 },
          { x: 5, y: 4 },
          { x: 5, y: 3 },
          { x: 6, y: 3 },
        ])],
        food: [{ x: 4, y: 5 }],
      }),
      ["right", "left"],
    );

    assert.ok(
      candidate(controlled.candidates, "right").features.foodAccess >
        candidate(contested.candidates, "right").features.foodAccess,
    );
    assert.ok(
      candidate(controlled.candidates, "right").probability >
        candidate(contested.candidates, "right").probability,
    );
  });

  it("converts the safe adjacent food from live turn 22 instead of a tiny territorial edge", () => {
    const state = gameState({
      youBody: [
        { x: 0, y: 6 }, { x: 0, y: 7 }, { x: 0, y: 8 }, { x: 0, y: 9 },
      ],
      health: 82,
      opponents: [
        opponent("palaserpiente", [
          { x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 6, y: 7 },
        ]),
        opponent("cascabel", [
          { x: 6, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 },
        ]),
        opponent("davibora", [
          { x: 4, y: 10 }, { x: 3, y: 10 }, { x: 3, y: 9 },
          { x: 3, y: 8 }, { x: 3, y: 7 }, { x: 3, y: 6 }, { x: 3, y: 6 },
        ]),
      ],
      food: [{ x: 0, y: 5 }],
    });
    const result = strategicRootPrior(
      state,
      ["right", "down"],
      liveControlWeights,
    );
    const territorial = candidate(result.candidates, "right");
    const eat = candidate(result.candidates, "down");

    assert.ok(eat.features.trapSafety > 0);
    assert.ok(eat.features.foodAccess > territorial.features.foodAccess);
    assert.ok(eat.probability > territorial.probability);
  });

  it("makes controlled progress toward food in the live turn-6 opening", () => {
    const state = gameState({
      youBody: [
        { x: 7, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 2 },
      ],
      health: 94,
      opponents: [
        opponent("palaserpiente", [
          { x: 7, y: 7 }, { x: 8, y: 7 }, { x: 9, y: 7 }, { x: 9, y: 8 },
        ]),
        opponent("cascabel", [
          { x: 2, y: 4 }, { x: 2, y: 5 }, { x: 1, y: 5 },
        ]),
        opponent("davibora", [
          { x: 2, y: 6 }, { x: 2, y: 7 }, { x: 2, y: 8 }, { x: 2, y: 9 },
        ]),
      ],
      food: [
        { x: 10, y: 2 }, { x: 0, y: 2 }, { x: 5, y: 5 }, { x: 9, y: 3 },
      ],
    });
    const result = strategicRootPrior(
      state,
      ["up", "right"],
      liveControlWeights,
    );
    const territorial = candidate(result.candidates, "up");
    const progress = candidate(result.candidates, "right");

    assert.ok(progress.features.trapSafety > 0);
    assert.ok(progress.features.foodAccess > territorial.features.foodAccess);
    assert.ok(progress.probability > territorial.probability);
  });

  it("keeps a longer snake's safe attack ahead of optional adjacent food", () => {
    const state = gameState({
      width: 5,
      height: 5,
      youBody: [
        { x: 2, y: 1 }, { x: 2, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: 0 }, { x: 0, y: 1 },
      ],
      opponents: [opponent("target", [
        { x: 4, y: 2 }, { x: 2, y: 3 }, { x: 2, y: 4 }, { x: 3, y: 4 },
      ])],
      food: [{ x: 1, y: 1 }],
    });
    const result = strategicRootPrior(state, ["up", "left"]);
    const attack = candidate(result.candidates, "up");
    const optionalFood = candidate(result.candidates, "left");

    assert.ok(attack.features.opponentPressure > optionalFood.features.opponentPressure);
    assert.ok(attack.probability > optionalFood.probability);
  });

  it("hard-gates a critical food route without removing MCTS alternatives", () => {
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
    const result = strategicRootPrior(state, ["left", "right", "up"]);
    const recover = candidate(result.candidates, "left");
    const abandon = candidate(result.candidates, "right");

    assert.equal(recover.tacticalIntent.kind, "RECOVER");
    assert.equal(recover.resourceBlocked, false);
    assert.equal(abandon.resourceBlocked, true);
    assert.ok(recover.probability > abandon.probability);
    assert.ok(abandon.probability > 0);
  });

  it("increases conversion priority from multiplayer toward a duel", () => {
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
    const probability = (opponents: ReturnType<typeof opponent>[]): number => {
      const result = strategicRootPrior(
        gameState({ ...base, opponents }),
        ["right", "left"],
      );
      return candidate(result.candidates, "right").probability;
    };

    const multiplayer = probability([target, distantOne, distantTwo]);
    const threePlayer = probability([target, distantOne]);
    const duel = probability([target]);

    assert.ok(threePlayer > multiplayer);
    assert.ok(duel > threePlayer);
  });

  it("always returns one normalized probability per requested move", () => {
    const state = gameState({
      opponents: [opponent("them", [
        { x: 9, y: 9 },
        { x: 9, y: 8 },
        { x: 9, y: 7 },
      ])],
      food: [{ x: 7, y: 5 }],
    });
    const result = strategicRootPrior(state, ["up", "right", "left"]);
    const total = result.candidates.reduce(
      (sum, item) => sum + item.probability,
      0,
    );

    assert.equal(result.candidates.length, 3);
    assert.ok(Math.abs(total - 1) < 1e-12);
    assert.ok(result.candidates.every((item) => item.probability > 0));
  });
});
