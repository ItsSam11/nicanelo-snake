import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  assertTelemetryModelVersion,
  laneSnakeEndpoints,
  parseJobOpponents,
  partitionBatchGames,
  serverTelemetryPath,
  stopProcess,
} from "../src/training/azure-job.js";

const OPPONENTS = [
  { name: "Devious-Devin", url: "http://127.0.0.1:8200/devious-devin" },
  { name: "Hovering-Hobbs", url: "http://127.0.0.1:8200/hovering-hobbs" },
  {
    name: "Improbable-Irene",
    url: "http://127.0.0.1:8200/improbable-irene",
  },
] as const;

describe("Azure tournament job", () => {
  it("splits ten games across two lanes without overlapping seeds or ports", () => {
    assert.deepEqual(partitionBatchGames(10, 2, 2_026_092_200), [
      {
        lane: 0,
        games: 5,
        baseSeed: 2_026_092_200,
        gameIndexOffset: 0,
        startPort: 8_101,
      },
      {
        lane: 1,
        games: 5,
        baseSeed: 2_026_092_205,
        gameIndexOffset: 5,
        startPort: 8_105,
      },
    ]);
  });

  it("distributes a remainder to the first lanes", () => {
    assert.deepEqual(partitionBatchGames(11, 3, 100, 9_000), [
      {
        lane: 0,
        games: 4,
        baseSeed: 100,
        gameIndexOffset: 0,
        startPort: 9_000,
      },
      {
        lane: 1,
        games: 4,
        baseSeed: 104,
        gameIndexOffset: 4,
        startPort: 9_004,
      },
      {
        lane: 2,
        games: 3,
        baseSeed: 108,
        gameIndexOffset: 8,
        startPort: 9_008,
      },
    ]);
  });

  it("continues global roster rotation across independent shards", () => {
    assert.deepEqual(partitionBatchGames(5, 2, 834, 8_101, 834), [
      {
        lane: 0,
        games: 3,
        baseSeed: 834,
        gameIndexOffset: 834,
        startPort: 8_101,
      },
      {
        lane: 1,
        games: 2,
        baseSeed: 837,
        gameIndexOffset: 837,
        startPort: 8_105,
      },
    ]);
  });

  it("rejects more lanes than games", () => {
    assert.throws(
      () => partitionBatchGames(1, 2, 100),
      /lanes must be between one and games/,
    );
  });

  it("keeps one Nicanelo process per lane against the pinned zoo roster", () => {
    assert.deepEqual(
      laneSnakeEndpoints(
        {
          lane: 0,
          games: 5,
          baseSeed: 100,
          gameIndexOffset: 0,
          startPort: 8_101,
        },
        OPPONENTS,
      ),
      [
        { name: "Nicanelo", url: "http://127.0.0.1:8101" },
        ...OPPONENTS,
      ],
    );
    assert.deepEqual(
      laneSnakeEndpoints(
        {
          lane: 1,
          games: 5,
          baseSeed: 105,
          gameIndexOffset: 5,
          startPort: 8_105,
        },
        OPPONENTS,
      ),
      [
        { name: "Nicanelo", url: "http://127.0.0.1:8105" },
        ...OPPONENTS,
      ],
    );
  });

  it("gives every Nicanelo lane a distinct local telemetry file", () => {
    const plan = {
      lane: 1,
      games: 5,
      baseSeed: 105,
      gameIndexOffset: 5,
      startPort: 8_105,
    };
    assert.equal(
      serverTelemetryPath("/tmp/run", plan),
      "/tmp/run/_telemetry/lane-02/nicanelo.jsonl",
    );
  });

  it("requires exactly three distinct HTTP zoo opponents", () => {
    assert.deepEqual(parseJobOpponents(JSON.stringify(OPPONENTS)), OPPONENTS);
    assert.throws(
      () => parseJobOpponents(JSON.stringify(OPPONENTS.slice(0, 2))),
      /exactly three opponents/,
    );
    assert.throws(
      () => parseJobOpponents(JSON.stringify([
        OPPONENTS[0],
        { ...OPPONENTS[1], name: OPPONENTS[0].name },
        OPPONENTS[2],
      ])),
      /names must be unique/,
    );
  });

  it("fails closed when telemetry used a different model", () => {
    assert.doesNotThrow(() =>
      assertTelemetryModelVersion(
        [{ modelVersion: "heuristic-adaptive-control-v1" }],
        "heuristic-adaptive-control-v1",
      )
    );
    assert.throws(
      () =>
        assertTelemetryModelVersion(
          [
            { modelVersion: "heuristic-adaptive-control-v1" },
            { modelVersion: "unexpected-model-v0" },
          ],
          "heuristic-adaptive-control-v1",
        ),
      /Telemetry model mismatch/,
    );
  });

  it("treats a process terminated by signal as already stopped", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ], { stdio: "ignore" });
    const managed = { child, stderr: () => "" };

    await stopProcess(managed);
    assert.equal(child.signalCode, "SIGTERM");
    await Promise.race([
      stopProcess(managed),
      delay(250).then(() => {
        throw new Error("second stopProcess call did not return immediately");
      }),
    ]);
  });
});
