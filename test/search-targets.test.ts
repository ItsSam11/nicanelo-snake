import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Direction } from "../src/api/types.js";
import type { MoveTelemetryRecord } from "../src/persistence/types.js";
import { canonicalStateKey } from "../src/search/state-key.js";
import {
  parsePuctPolicyTargetsJsonl,
  puctPolicyTargets,
  serializePuctPolicyTargets,
  validatePuctPolicyTargetsForReplay,
} from "../src/training/search-targets.js";
import { gameState } from "./fixtures.js";

function moveRecord(
  overrides: Omit<Partial<MoveTelemetryRecord>, "search"> & {
    search?: Partial<MoveTelemetryRecord["search"]>;
  } = {},
): MoveTelemetryRecord {
  const state = gameState();
  const search: MoveTelemetryRecord["search"] = {
    iterations: 12,
    elapsedMs: 20,
    deadlineReached: false,
    usedSearch: true,
    fallbackProtected: false,
    priorVisits: 0,
    reusedTree: false,
    cacheHits: 0,
    cacheMisses: 1,
    workersRequested: 2,
    workersCompleted: 2,
    rootStatistics: [
      { move: "up", visits: 3, meanValue: 0.2, outcomeCount: 3, prior: 0.4 },
      { move: "right", visits: 9, meanValue: 0.7, outcomeCount: 9, prior: 0.6 },
    ],
    ...overrides.search,
  };
  return {
    schemaVersion: 1,
    eventId: "event-1",
    event: "move",
    recordedAt: "2026-09-17T01:00:00.000Z",
    modelVersion: "heuristic-puct-v1",
    gameId: state.game.id,
    turn: state.turn,
    ruleset: state.game.ruleset.name,
    map: state.game.map,
    stateKey: canonicalStateKey(state),
    state,
    fallbackMove: "up",
    finalMove: "right",
    requestElapsedMs: 25,
    observedOpponentMoves: [],
    ...overrides,
    search,
  };
}

describe("PUCT policy targets", () => {
  it("normalizes root visits and attaches the controlled snake outcome", () => {
    const record = moveRecord();
    const [target] = puctPolicyTargets([record], {
      winnerId: record.state.you.id,
      winnerName: record.state.you.name,
      isDraw: false,
    });

    assert.equal(target?.policyEligible, true);
    assert.equal(target?.outcome, 1);
    assert.equal(target?.totalVisits, 12);
    assert.deepEqual(
      target?.actions.map(({ move, probability }) => ({ move, probability })),
      [
        { move: "up", probability: 0.25 },
        { move: "right", probability: 0.75 },
      ],
    );
    assert.equal(serializePuctPolicyTargets([target!]).split("\n").length, 2);
    const parsed = parsePuctPolicyTargetsJsonl(
      serializePuctPolicyTargets([target!]),
    );
    assert.doesNotThrow(() => validatePuctPolicyTargetsForReplay(parsed, {
      metadata: record.state.game,
      states: [record.state],
      result: {
        winnerId: record.state.you.id,
        winnerName: record.state.you.name,
        isDraw: false,
      },
    }));
  });

  it("keeps degraded searches for audit but marks them ineligible", () => {
    const record = moveRecord({
      finalMove: "left",
      search: {
        usedSearch: false,
        fallbackProtected: true,
        rootStatistics: [],
      },
    });
    const [target] = puctPolicyTargets([record], {
      winnerId: "",
      winnerName: "",
      isDraw: true,
    });

    assert.equal(target?.outcome, 0.5);
    assert.equal(target?.policyEligible, false);
    assert.deepEqual(target?.exclusionReasons, [
      "search-not-used",
      "fallback-protected",
      "no-root-visits",
      "selected-move-unvisited",
    ]);
  });

  it("does not train the policy prior toward a risk-vetoed visit leader", () => {
    const record = moveRecord({
      finalMove: "up",
      search: {
        rootStatistics: [
          { move: "right", visits: 64, meanValue: -0.9, outcomeCount: 16 },
          { move: "up", visits: 40, meanValue: -0.2, outcomeCount: 12 },
        ],
      },
    });
    const [target] = puctPolicyTargets([record], {
      winnerId: "other",
      winnerName: "other",
      isDraw: false,
    });

    assert.equal(target?.policyEligible, false);
    assert.deepEqual(target?.exclusionReasons, ["root-risk-overridden"]);
  });

  it("never trains through an explicit root-safety override", () => {
    const record = moveRecord({
      finalMove: "up",
      search: {
        rootStatistics: [
          { move: "right", visits: 50, meanValue: 0.4, outcomeCount: 16 },
          { move: "up", visits: 50, meanValue: 0.4, outcomeCount: 16 },
        ],
        rootSafety: {
          proposedMove: "right",
          move: "up",
          overridden: true,
          reason: "avoided-zero-exit-exposure",
          proposedWorstCaseNextMoves: 0,
          selectedWorstCaseNextMoves: 2,
          proposedReplyScenarios: 4,
          proposedImmediateNonWinReplies: 0,
          proposedZeroNextMoveReplies: 4,
          proposedTerminalWinReplies: 0,
          selectedReplyScenarios: 4,
          selectedImmediateNonWinReplies: 0,
          selectedZeroNextMoveReplies: 0,
          selectedTerminalWinReplies: 0,
        },
      },
    });
    const [target] = puctPolicyTargets([record], {
      winnerId: record.state.you.id,
      winnerName: record.state.you.name,
      isDraw: false,
    });

    assert.equal(target?.rootSafetyOverridden, true);
    assert.equal(target?.policyEligible, false);
    assert.deepEqual(target?.exclusionReasons, ["root-safety-overridden"]);
    assert.doesNotThrow(() =>
      parsePuctPolicyTargetsJsonl(serializePuctPolicyTargets([target!]))
    );
  });

  it("rejects ambiguous duplicate snake turns", () => {
    const first = moveRecord();
    const second = moveRecord({ eventId: "event-2" });
    assert.throws(
      () => puctPolicyTargets([first, second], {
        winnerId: "other",
        winnerName: "other",
        isDraw: false,
      }),
      /Duplicate move telemetry/u,
    );
  });

  it("rejects duplicate root actions", () => {
    const repeatedMove: Direction = "up";
    const record = moveRecord({
      search: {
        rootStatistics: [
          { move: repeatedMove, visits: 1, meanValue: 0, outcomeCount: 1 },
          { move: repeatedMove, visits: 2, meanValue: 0, outcomeCount: 2 },
        ],
      },
    });
    assert.throws(
      () => puctPolicyTargets([record], {
        winnerId: "other",
        winnerName: "other",
        isDraw: false,
      }),
      /Duplicate root move/u,
    );
  });
});
