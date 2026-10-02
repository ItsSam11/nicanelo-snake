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
import { canonicalStateKey } from "../src/search/state-key.js";
import { prepareCorpus } from "../src/training/prepare-corpus.js";
import { PUCT_POLICY_TARGET_VERSION } from "../src/training/search-targets.js";
import {
  buildProfileReference,
  serializeProfileReference,
} from "../src/training/profile-reference.js";
import {
  buildReplayCorpus,
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
  const current = initial.board.snakes[0]!;
  const head = { x: current.head.x, y: current.head.y + 1 };
  const winner = {
    ...current,
    head,
    body: [head, ...current.body.slice(0, -1)],
  };
  return {
    metadata: initial.game,
    states: [
      initial,
      {
        ...initial,
        turn: initial.turn + 1,
        board: { ...initial.board, snakes: [winner] },
        you: winner,
      },
    ],
    result: { winnerId: winner.id, winnerName: winner.name, isDraw: false },
  };
}

async function writeGame(
  telemetryRoot: string,
  directoryName: string,
  source: OfficialReplay,
  summaryGameId = source.metadata.id,
  withSearchTargets = false,
): Promise<void> {
  const directory = join(telemetryRoot, "raw", "gym", "run", directoryName);
  await mkdir(directory, { recursive: true });
  const summary = {
    ...buildReplayCorpus(source, { source: "gym" }).summary,
    gameId: summaryGameId,
  };
  const writes = [
    writeFile(join(directory, "record.jsonl"), serializeOfficialReplay(source)),
    writeFile(join(directory, "summary.json"), `${JSON.stringify(summary)}\n`),
  ];
  if (withSearchTargets) {
    writes.push(writeFile(
      join(directory, "search-observations.jsonl"),
      `${JSON.stringify({
        targetVersion: PUCT_POLICY_TARGET_VERSION,
        telemetryEventId: "event-1",
        recordedAt: "2026-09-17T02:00:00.000Z",
        gameId: source.metadata.id,
        turn: source.states[0]!.turn,
        snakeId: source.states[0]!.you.id,
        snakeName: source.states[0]!.you.name,
        stateKey: canonicalStateKey(source.states[0]!),
        modelVersion: "heuristic-puct-v1",
        selectedMove: "up",
        fallbackMove: "up",
        outcome: 1,
        usedSearch: true,
        fallbackProtected: false,
        rootSafetyOverridden: false,
        deadlineReached: false,
        iterations: 1,
        priorVisits: 0,
        reusedTree: false,
        workersRequested: 1,
        workersCompleted: 1,
        totalVisits: 1,
        policyEligible: true,
        exclusionReasons: [],
        actions: [{
          move: "up",
          visits: 1,
          probability: 1,
          meanValue: 0.5,
          outcomeCount: 1,
          prior: 1,
        }],
      })}\n`,
    ));
  }
  await Promise.all(writes);
}

describe("corpus preparation", () => {
  it("freezes valid games and rejects duplicate or mismatched records", async () => {
    const telemetryRoot = await mkdtemp(join(tmpdir(), "snake-prepare-"));
    try {
      await Promise.all([
        writeGame(
          telemetryRoot,
          "valid",
          replay("game-valid"),
          "game-valid",
          true,
        ),
        writeGame(
          telemetryRoot,
          "duplicate",
          replay("game-valid"),
          "game-valid",
          true,
        ),
        writeGame(
          telemetryRoot,
          "mismatch",
          replay("record-game"),
          "summary-game",
        ),
      ]);

      const reference = buildProfileReference(
        buildReplayCorpus(replay("reference-game"), { source: "gym" }).summary
          .profiles,
        "profile-reference-test",
        "2026-09-17T00:00:00.000Z",
      );
      await mkdir(join(telemetryRoot, "references"), { recursive: true });
      await writeFile(
        join(telemetryRoot, "references", "profile-reference-test.json"),
        serializeProfileReference(reference),
      );
      const result = await prepareCorpus(
        telemetryRoot,
        "selection-test",
        "corpus-test",
        "profile-reference-test",
      );
      assert.equal(result.eligible, 1);
      assert.equal(result.selected, 1);
      assert.equal(result.rejected, 2);

      const manifest = await readFile(result.corpusManifest, "utf8");
      assert.match(manifest, /"gameId":"game-valid"/u);
      assert.match(manifest, /"schemaVersion":3/u);
      assert.match(manifest, /"searchObservationsPath"/u);
      const rejected = await readFile(
        join(
          telemetryRoot,
          "eligible",
          "selection-test",
          "rejected.jsonl",
        ),
        "utf8",
      );
      assert.match(rejected, /duplicate-game-id/u);
      assert.match(rejected, /invalid-or-mismatched-record/u);
    } finally {
      await rm(telemetryRoot, { recursive: true, force: true });
    }
  });
});
