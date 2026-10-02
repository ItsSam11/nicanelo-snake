import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Battlesnake, Direction, GameState } from "../src/api/types.js";
import {
  PersistenceCoordinator,
} from "../src/persistence/coordinator.js";
import type {
  HotGameSummary,
  HotStateStore,
  PersistenceRecord,
  TelemetrySink,
} from "../src/persistence/types.js";
import type { PooledSearchResult } from "../src/search/search-pool.js";
import { gameState, opponent } from "./fixtures.js";

class MemoryTelemetrySink implements TelemetrySink {
  readonly records: PersistenceRecord[] = [];

  async write(record: Readonly<PersistenceRecord>): Promise<void> {
    this.records.push(record);
  }

  async close(): Promise<void> {}
}

class MemoryHotStateStore implements HotStateStore {
  readonly summaries: HotGameSummary[] = [];

  async write(summary: Readonly<HotGameSummary>): Promise<void> {
    this.summaries.push(summary);
  }

  async close(): Promise<void> {}
}

function diagnostics(move: Direction = "right"): PooledSearchResult {
  return {
    move,
    fallbackMove: "up",
    iterations: 24,
    elapsedMs: 12,
    deadlineReached: false,
    usedSearch: true,
    fallbackProtected: false,
    rootStatistics: [
      { move, visits: 24, meanValue: 0.75, outcomeCount: 4 },
    ],
    priorVisits: 8,
    reusedTree: true,
    cacheHits: 5,
    cacheMisses: 2,
    workersRequested: 4,
    workersCompleted: 4,
    rootSafety: {
      proposedMove: move,
      move,
      overridden: false,
      reason: "accepted",
      proposedWorstCaseNextMoves: 2,
      selectedWorstCaseNextMoves: 2,
      proposedReplyScenarios: 4,
      proposedImmediateNonWinReplies: 0,
      proposedZeroNextMoveReplies: 0,
      proposedTerminalWinReplies: 0,
      selectedReplyScenarios: 4,
      selectedImmediateNonWinReplies: 0,
      selectedZeroNextMoveReplies: 0,
      selectedTerminalWinReplies: 0,
    },
  };
}

function moved(snake: Battlesnake, move: Direction): Battlesnake {
  const offsets: Record<Direction, { x: number; y: number }> = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const offset = offsets[move];
  const head = {
    x: snake.head.x + offset.x,
    y: snake.head.y + offset.y,
  };
  const body = [head, ...snake.body.slice(0, -1)];
  return { ...snake, head, body, length: body.length };
}

function nextState(
  state: GameState,
  ourMove: Direction,
  opponentMove: Direction,
): GameState {
  const us = moved(state.you, ourMove);
  const rival = moved(state.board.snakes[1]!, opponentMove);
  return {
    ...state,
    turn: state.turn + 1,
    board: { ...state.board, snakes: [us, rival] },
    you: us,
  };
}

describe("phase-eight persistence coordinator", () => {
  it("records durable telemetry and compact shared summaries in order", async () => {
    const telemetry = new MemoryTelemetrySink();
    const hotState = new MemoryHotStateStore();
    let event = 0;
    const coordinator = new PersistenceCoordinator({
      telemetrySink: telemetry,
      hotStateStore: hotState,
      now: () => new Date("2026-09-16T05:00:00.000Z"),
      eventId: () => `event-${event += 1}`,
      modelVersion: "test-model",
    });
    const initial = gameState({
      opponents: [
        opponent("them", [
          { x: 8, y: 8 },
          { x: 8, y: 7 },
          { x: 8, y: 6 },
        ]),
      ],
    });
    const next = nextState(initial, "right", "left");

    coordinator.recordStart(initial);
    coordinator.recordMove({
      state: initial,
      diagnostics: diagnostics(),
      requestElapsedMs: 18,
    });
    coordinator.recordMove({
      state: next,
      diagnostics: diagnostics("up"),
      requestElapsedMs: 19,
    });
    coordinator.recordEnd(next);
    await coordinator.close();

    assert.deepEqual(
      telemetry.records.map((record) => record.event),
      ["game_start", "move", "move", "game_end"],
    );
    const secondMove = telemetry.records[2];
    assert.equal(secondMove?.event, "move");
    if (secondMove?.event === "move") {
      assert.deepEqual(secondMove.observedOpponentMoves, [
        { snakeId: "them", snakeName: "them", move: "left" },
      ]);
      assert.equal(secondMove.modelVersion, "test-model");
      assert.equal(secondMove.search.workersCompleted, 4);
      assert.equal(secondMove.search.rootSafety?.reason, "accepted");
      assert.equal(secondMove.search.rootSafety?.move, "up");
      assert.equal(secondMove.state.turn, 11);
    }
    assert.equal(hotState.summaries.length, 2);
    assert.equal(hotState.summaries[1]?.rootSafety?.move, "up");
    assert.equal(coordinator.statistics.failed, 0);
    assert.equal(coordinator.statistics.pending, 0);
  });

  it("starts persistence only after returning to the event loop", async () => {
    let writeStarted = false;
    const telemetry: TelemetrySink = {
      write: async () => {
        writeStarted = true;
      },
      close: async () => undefined,
    };
    const coordinator = new PersistenceCoordinator({ telemetrySink: telemetry });

    coordinator.recordMove({
      state: gameState(),
      diagnostics: diagnostics(),
      requestElapsedMs: 20,
    });
    assert.equal(writeStarted, false);
    await Promise.resolve();
    await coordinator.close();
    assert.equal(writeStarted, true);
  });

  it("keeps opponent observations isolated across interleaved game ids", async () => {
    const telemetry = new MemoryTelemetrySink();
    const coordinator = new PersistenceCoordinator({ telemetrySink: telemetry });
    const firstA = gameState({
      opponents: [opponent("rival-a", [
        { x: 8, y: 8 },
        { x: 8, y: 7 },
        { x: 8, y: 6 },
      ])],
    });
    firstA.game.id = "continuity-a";
    const firstB = gameState({
      opponents: [opponent("rival-b", [
        { x: 2, y: 8 },
        { x: 2, y: 7 },
        { x: 2, y: 6 },
      ])],
    });
    firstB.game.id = "continuity-b";
    const secondA = nextState(firstA, "right", "left");
    const secondB = nextState(firstB, "left", "right");

    coordinator.recordStart(firstA);
    coordinator.recordStart(firstB);
    coordinator.recordMove({
      state: secondA,
      diagnostics: diagnostics(),
      requestElapsedMs: 18,
    });
    coordinator.recordMove({
      state: secondB,
      diagnostics: diagnostics(),
      requestElapsedMs: 18,
    });
    await coordinator.close();

    const moves = telemetry.records.filter((record) => record.event === "move");
    assert.deepEqual(moves.map((record) => ({
      gameId: record.gameId,
      observations: record.observedOpponentMoves,
    })), [
      {
        gameId: "continuity-a",
        observations: [
          { snakeId: "rival-a", snakeName: "rival-a", move: "left" },
        ],
      },
      {
        gameId: "continuity-b",
        observations: [
          { snakeId: "rival-b", snakeName: "rival-b", move: "right" },
        ],
      },
    ]);
  });

  it("contains sink failures instead of affecting move correctness", async () => {
    const errors: Readonly<Record<string, unknown>>[] = [];
    const coordinator = new PersistenceCoordinator({
      telemetrySink: {
        write: async () => {
          throw new Error("storage unavailable");
        },
        close: async () => undefined,
      },
      logger: (entry) => errors.push(entry),
      flushTimeoutMs: 100,
    });

    assert.doesNotThrow(() => {
      coordinator.recordMove({
        state: gameState(),
        diagnostics: diagnostics(),
        requestElapsedMs: 20,
      });
    });
    await coordinator.close();

    assert.equal(coordinator.statistics.failed, 1);
    assert.equal(errors[0]?.event, "persistence_error");
  });
});
