import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  opponentMoveDistribution,
  policyPriorMoveDistribution,
  resolveOpponentPolicy,
  sampleOpponentMove,
} from "../src/search/opponent-policy.js";
import { gameState, opponent } from "./fixtures.js";

describe("probabilistic opponent policy", () => {
  it("gives our prior non-zero, state-dependent strategic interactions", () => {
    const rival = opponent("them", [
      { x: 7, y: 5 },
      { x: 7, y: 4 },
      { x: 7, y: 3 },
    ]);
    const state = gameState({ opponents: [rival] });
    const distribution = policyPriorMoveDistribution(
      state,
      state.you.id,
      resolveOpponentPolicy({
        weights: {
          contextualAggression: 2,
          contextualResourceAcquisition: 1,
          contextualHealthManagement: 1,
          contextualConservatism: 1,
        },
      }),
    );

    assert.ok(
      distribution.some((candidate) =>
        Math.abs(candidate.features.contextualAggression) > 1e-9
      ),
    );
    assert.ok(
      distribution.some((candidate) =>
        Math.abs(candidate.features.contextualConservatism) > 1e-9
      ),
    );
  });

  it("returns a normalized distribution over physically viable moves", () => {
    const rival = opponent("them", [
      { x: 8, y: 8 },
      { x: 8, y: 7 },
      { x: 8, y: 6 },
    ]);
    const distribution = opponentMoveDistribution(
      gameState({ opponents: [rival] }),
      rival.id,
    );

    assert.ok(distribution.length > 1);
    assert.ok(distribution.every((candidate) => candidate.probability > 0));
    assert.ok(
      Math.abs(
        distribution.reduce(
          (sum, candidate) => sum + candidate.probability,
          0,
        ) - 1,
      ) < 1e-12,
    );
  });

  it("assigns more probability to adjacent food when the rival is hungry", () => {
    const hungryRival = {
      ...opponent("them", [
        { x: 5, y: 5 },
        { x: 5, y: 4 },
        { x: 5, y: 3 },
      ]),
      health: 10,
    };
    const state = gameState({
      youBody: [
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [hungryRival],
      food: [{ x: 6, y: 5 }],
    });
    const distribution = opponentMoveDistribution(state, hungryRival.id);
    const right = distribution.find((candidate) => candidate.move === "right");
    const left = distribution.find((candidate) => candidate.move === "left");

    assert.ok(right !== undefined && left !== undefined);
    assert.ok(right.probability > left.probability);
    assert.ok(right.features.foodAccess > left.features.foodAccess);
  });

  it("models moderate high-health maintenance eating", () => {
    const rival = opponent("them", [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
    ]);
    const state = gameState({
      youBody: [
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      opponents: [rival],
      food: [{ x: 6, y: 5 }],
    });
    const distribution = opponentMoveDistribution(state, rival.id);
    const right = distribution.find((candidate) => candidate.move === "right");
    const left = distribution.find((candidate) => candidate.move === "left");

    assert.ok(right !== undefined && left !== undefined);
    assert.ok(right.features.foodAccess > 0);
    assert.ok(right.features.foodAccess > left.features.foodAccess);
  });

  it("penalizes a possible head-to-head against an equal snake", () => {
    const rival = opponent("them", [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
    ]);
    const state = gameState({
      youBody: [
        { x: 3, y: 5 },
        { x: 3, y: 4 },
        { x: 3, y: 3 },
      ],
      opponents: [rival],
    });
    const distribution = opponentMoveDistribution(state, rival.id);
    const contested = distribution.find(
      (candidate) => candidate.move === "left",
    );
    const open = distribution.find((candidate) => candidate.move === "right");

    assert.ok(contested !== undefined && open !== undefined);
    assert.equal(contested.features.headSafety, 0);
    assert.equal(open.features.headSafety, 1);
    assert.ok(contested.probability < open.probability);
  });

  it("uses only causal behavior history to condition rival choices", () => {
    const rival = opponent("them", [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
    ]);
    const state = gameState({
      youBody: [
        { x: 3, y: 5 },
        { x: 3, y: 4 },
        { x: 3, y: 3 },
      ],
      opponents: [rival],
    });
    const settings = resolveOpponentPolicy({
      temperature: 1,
      weights: {
        mobility: 0,
        foodAccess: 0,
        headSafety: 0,
        hazardSafety: 0,
        wallDistance: 0,
        contextualAggression: 8,
        contextualResourceAcquisition: 0,
        contextualHealthManagement: 0,
        contextualConservatism: 0,
      },
    });
    const context = (aggression: number) => ({
      scores: {
        aggression,
        resourceAcquisition: 0.5,
        healthManagement: 0.5,
        conservatism: 0.5,
      },
      opportunities: {
        aggression: 12,
        resourceAcquisition: 0,
        healthManagement: 0,
        conservatism: 0,
      },
      confidence: {
        aggression: 1,
        resourceAcquisition: 0,
        healthManagement: 0,
        conservatism: 0,
        overall: 0.25,
      },
      decisionsObserved: 12,
      decisionDenseTurns: 12,
      decisionDensity: 1,
    });
    const aggressive = opponentMoveDistribution(
      state,
      rival.id,
      settings,
      context(1),
    );
    const conservative = opponentMoveDistribution(
      state,
      rival.id,
      settings,
      context(0),
    );
    const toward = (distribution: typeof aggressive) =>
      distribution.find((candidate) => candidate.move === "left")?.probability ?? 0;

    assert.ok(toward(aggressive) > toward(conservative));
  });

  it("uses learned aggression to raise the danger of contested food", () => {
    const rival = opponent("them", [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
    ]);
    const state = gameState({
      youBody: [
        { x: 3, y: 5 },
        { x: 3, y: 4 },
        { x: 3, y: 3 },
      ],
      opponents: [rival],
      food: [{ x: 4, y: 5 }],
    });
    const settings = resolveOpponentPolicy({
      temperature: 1,
      weights: {
        mobility: 0,
        foodAccess: 0,
        headSafety: 0,
        hazardSafety: 0,
        wallDistance: 0,
        contextualAggression: 8,
        contextualResourceAcquisition: 0,
        contextualHealthManagement: 0,
        contextualConservatism: 0,
      },
    });
    const context = (aggression: number) => ({
      scores: {
        aggression,
        resourceAcquisition: 0.5,
        healthManagement: 0.5,
        conservatism: 0.5,
      },
      opportunities: {
        aggression: 12,
        resourceAcquisition: 0,
        healthManagement: 0,
        conservatism: 0,
      },
      confidence: {
        aggression: 1,
        resourceAcquisition: 0,
        healthManagement: 0,
        conservatism: 0,
        overall: 0.25,
      },
      decisionsObserved: 12,
      decisionDenseTurns: 12,
      decisionDensity: 1,
    });
    const aggressive = opponentMoveDistribution(
      state,
      rival.id,
      settings,
      context(1),
    );
    const conservative = opponentMoveDistribution(
      state,
      rival.id,
      settings,
      context(0),
    );
    const contestProbability = (distribution: typeof aggressive) =>
      distribution.find((candidate) => candidate.move === "left")
        ?.probability ?? 0;

    assert.ok(contestProbability(aggressive) > contestProbability(conservative));
  });

  it("samples deterministically from an injected random value", () => {
    const rival = opponent("them", [
      { x: 8, y: 8 },
      { x: 8, y: 7 },
      { x: 8, y: 6 },
    ]);
    const distribution = opponentMoveDistribution(
      gameState({ opponents: [rival] }),
      rival.id,
    );

    assert.equal(sampleOpponentMove(distribution, () => 0), distribution[0]?.move);
    assert.equal(
      sampleOpponentMove(distribution, () => 1),
      distribution.at(-1)?.move,
    );
  });

  it("rejects invalid temperature", () => {
    assert.throws(
      () => resolveOpponentPolicy({ temperature: 0 }),
      /temperature must be positive and finite/,
    );
  });
});
