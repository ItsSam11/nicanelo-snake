import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strategicPosture } from "../src/strategy/strategic-posture.js";
import { gameState, opponent } from "./fixtures.js";

const rivalBodies = [
  [
    { x: 9, y: 9 },
    { x: 9, y: 8 },
    { x: 9, y: 7 },
  ],
  [
    { x: 1, y: 9 },
    { x: 1, y: 8 },
    { x: 1, y: 7 },
  ],
  [
    { x: 9, y: 1 },
    { x: 9, y: 2 },
    { x: 9, y: 3 },
  ],
] as const;

describe("adaptive strategic posture", () => {
  it("raises initiative as a safe game advances toward a duel", () => {
    const rivals = rivalBodies.map((body, index) =>
      opponent(`rival-${index}`, [...body])
    );
    const multiplayer = strategicPosture(gameState({ opponents: rivals }));
    const threePlayer = strategicPosture(
      gameState({ opponents: rivals.slice(0, 2) }),
    );
    const duel = strategicPosture(
      gameState({ opponents: rivals.slice(0, 1) }),
    );

    assert.equal(multiplayer.phase, "multiplayer");
    assert.equal(threePlayer.phase, "three-player");
    assert.equal(duel.phase, "duel");
    assert.ok(threePlayer.initiative > multiplayer.initiative);
    assert.ok(duel.initiative > threePlayer.initiative);
    assert.ok(
      duel.context.scores.aggression >
        multiplayer.context.scores.aggression,
    );
    assert.ok(
      duel.context.scores.conservatism <
        multiplayer.context.scores.conservatism,
    );
  });

  it("moves from initiative to resource recovery when health is critical", () => {
    const rival = opponent("rival", [...rivalBodies[0]]);
    const healthy = strategicPosture(
      gameState({ opponents: [rival], health: 90 }),
    );
    const critical = strategicPosture(
      gameState({ opponents: [rival], health: 12 }),
    );

    assert.ok(healthy.initiative > critical.initiative);
    assert.ok(critical.resourceUrgency > healthy.resourceUrgency);
    assert.ok(
      critical.context.scores.healthManagement >
        healthy.context.scores.healthManagement,
    );
    assert.ok(
      critical.context.scores.conservatism >
        healthy.context.scores.conservatism,
    );
  });

  it("keeps modest initiative with one safe exit but none when fully trapped", () => {
    const distant = opponent("distant", [
      { x: 4, y: 4 },
      { x: 4, y: 3 },
      { x: 4, y: 2 },
    ]);
    const oneExit = strategicPosture(
      gameState({
        width: 5,
        height: 5,
        youBody: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
        opponents: [distant],
      }),
    );
    const trapped = strategicPosture(
      gameState({
        width: 5,
        height: 5,
        youBody: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
        opponents: [
          opponent("blocker", [
            { x: 2, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 1 },
          ]),
        ],
      }),
    );

    assert.ok(oneExit.safetyReserve > 0);
    assert.ok(oneExit.initiative > 0);
    assert.ok(oneExit.context.scores.aggression > 0.35);
    assert.equal(trapped.safetyReserve, 0);
    assert.equal(trapped.initiative, 0);
  });
});
