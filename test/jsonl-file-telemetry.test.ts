import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonlFileTelemetrySink } from "../src/persistence/jsonl-file.js";
import type { GameLifecycleTelemetryRecord } from "../src/persistence/types.js";
import { gameState } from "./fixtures.js";

describe("process-local JSONL telemetry", () => {
  it("creates one exclusive append-only file per snake process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snake-telemetry-"));
    const path = join(directory, "lane-01", "seat-a.jsonl");
    const state = gameState();
    const record: GameLifecycleTelemetryRecord = {
      schemaVersion: 1,
      eventId: "start-1",
      event: "game_start",
      recordedAt: "2026-09-17T00:00:00.000Z",
      modelVersion: "heuristic-puct-v1",
      gameId: state.game.id,
      turn: state.turn,
      ruleset: state.game.ruleset.name,
      map: state.game.map,
      state,
    };

    try {
      const sink = new JsonlFileTelemetrySink(path);
      await sink.write(record);
      await sink.write({
        ...record,
        eventId: "end-1",
        event: "game_end",
        recordedAt: "2026-09-17T00:01:00.000Z",
      });
      await sink.close();

      const lines = (await readFile(path, "utf8")).trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]!).event, "game_start");
      assert.equal(JSON.parse(lines[1]!).event, "game_end");

      const duplicate = new JsonlFileTelemetrySink(path);
      await assert.rejects(duplicate.write(record), /EEXIST/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
