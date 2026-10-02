import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rebuildDerivedData } from "../src/training/rebuild-derived-data.js";
import {
  parseReplaySummary,
  serializeOfficialReplay,
  type OfficialReplay,
} from "../src/training/replay-corpus.js";
import { gameState, opponent } from "./fixtures.js";

function replay(gameId: string): OfficialReplay {
  const initialState = gameState({
    opponents: [
      opponent("a", [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }]),
      opponent("b", [{ x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 }]),
      opponent("c", [{ x: 1, y: 9 }, { x: 1, y: 8 }, { x: 1, y: 7 }]),
    ],
  });
  const initial = {
    ...initialState,
    game: { ...initialState.game, id: gameId },
  };
  const movedSnakes = initial.board.snakes.map((snake, index) => {
    const head = index === 0
      ? { x: snake.head.x, y: snake.head.y + 1 }
      : { x: snake.head.x, y: snake.head.y - 1 };
    const body = [head, ...snake.body.slice(0, -1)];
    return { ...snake, head, body, length: body.length };
  });
  const next = {
    ...initial,
    turn: initial.turn + 1,
    board: { ...initial.board, snakes: movedSnakes },
    you: movedSnakes[0]!,
  };
  return {
    metadata: initial.game,
    states: [initial, next],
    result: { winnerId: "us", winnerName: "us", isDraw: false },
  };
}

describe("derived telemetry migration", () => {
  it("rebuilds schema-two derivatives without changing the immutable replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "snake-derived-"));
    const gameDirectory = join(root, "gym", "run", "game-1");
    try {
      await mkdir(gameDirectory, { recursive: true });
      const record = serializeOfficialReplay(replay("migration-game"));
      await Promise.all([
        writeFile(join(gameDirectory, "record.jsonl"), record),
        writeFile(
          join(gameDirectory, "summary.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            source: "gym",
            runId: "legacy-run",
            seed: 42,
            modelVersions: ["heuristic-puct-v1"],
          })}\n`,
        ),
        writeFile(join(gameDirectory, "observations.jsonl"), "legacy\n"),
      ]);

      assert.deepEqual(await rebuildDerivedData(root), {
        upgraded: 1,
        current: 0,
      });

      assert.equal(await readFile(join(gameDirectory, "record.jsonl"), "utf8"), record);
      const summary = parseReplaySummary(
        await readFile(join(gameDirectory, "summary.json"), "utf8"),
      );
      assert.equal(summary.schemaVersion, 2);
      assert.equal(summary.runId, "legacy-run");
      assert.equal(summary.seed, 42);
      assert.deepEqual(summary.modelVersions, ["heuristic-puct-v1"]);
      assert.equal("winner" in summary.profiles[0]!.metrics, false);

      const observations = (await readFile(
        join(gameDirectory, "observations.jsonl"),
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        behaviorBeforeMove: { decisionsObserved: number };
      });
      assert.equal(observations.length, 4);
      assert.equal(observations[0]!.behaviorBeforeMove.decisionsObserved, 0);
      assert.deepEqual(await rebuildDerivedData(root), {
        upgraded: 0,
        current: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
