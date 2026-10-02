import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildBattlesnakeArguments,
  parseBatchOptions,
  parseRunProvenance,
  rotateSnakeEndpoints,
  runBatch,
} from "../src/training/batch-tournament.js";

const SNAKES = [
  "A=http://127.0.0.1:8101",
  "B=http://127.0.0.1:8102",
  "C=http://127.0.0.1:8103",
  "D=http://127.0.0.1:8104",
];

describe("two-to-four-snake tournament batch", () => {
  it("builds an official standard 11x11 seeded game", () => {
    const options = parseBatchOptions([
      "--games", "3",
      "--base-seed", "2026091600",
      "--run-id", "test-run",
      "--output", "/tmp/corpus",
      "--provenance", "/tmp/provenance.json",
      ...SNAKES.flatMap((snake) => ["--snake", snake]),
    ]);
    const args = buildBattlesnakeArguments(
      options,
      2026091601,
      "/tmp/corpus/game.jsonl",
    );

    assert.equal(options.snakes.length, 4);
    assert.equal(options.runId, "test-run");
    assert.equal(options.provenanceFile, "/tmp/provenance.json");
    assert.deepEqual(args.slice(0, 15), [
      "play",
      "--width", "11",
      "--height", "11",
      "--gametype", "standard",
      "--map", "standard",
      "--timeout", "500",
      "--seed", "2026091601",
      "--output", "/tmp/corpus/game.jsonl",
    ]);
    assert.equal(args.filter((value) => value === "--name").length, 4);
    assert.equal(args.filter((value) => value === "--url").length, 4);
  });

  it("accepts complete rosters of two, three, or four snakes", () => {
    for (const count of [2, 3, 4]) {
      const options = parseBatchOptions(
        SNAKES.slice(0, count).flatMap((snake) => ["--snake", snake]),
      );
      const args = buildBattlesnakeArguments(options, 100, "/tmp/game.jsonl");

      assert.equal(options.snakes.length, count);
      assert.equal(args.filter((value) => value === "--name").length, count);
      assert.equal(args.filter((value) => value === "--url").length, count);
    }
  });

  it("refuses rosters outside the supported two-to-four range", () => {
    for (const snakes of [
      SNAKES.slice(0, 1),
      [...SNAKES, "E=http://127.0.0.1:8105"],
    ]) {
      assert.throws(
        () => parseBatchOptions(
          snakes.flatMap((snake) => ["--snake", snake]),
        ),
        /requires between two and four snakes/,
      );
    }
  });

  it("applies the roster range to programmatic batch calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nicanelo-invalid-roster-"));
    try {
      await assert.rejects(
        runBatch({
          games: 1,
          baseSeed: 1,
          outputDirectory: join(directory, "batch"),
          runId: "invalid-roster",
          timeoutMs: 500,
          battlesnakeBinary: "/usr/bin/false",
          snakes: [{ name: "A", url: "http://a" }],
        }),
        /requires between two and four snakes/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates snake order by game so every roster seat is balanced", () => {
    const snakes = [
      { name: "A", url: "http://a" },
      { name: "B", url: "http://b" },
      { name: "C", url: "http://c" },
      { name: "D", url: "http://d" },
    ];
    assert.deepEqual(
      Array.from({ length: 5 }, (_, index) =>
        rotateSnakeEndpoints(snakes, index).map((snake) => snake.name)
      ),
      [
        ["A", "B", "C", "D"],
        ["B", "C", "D", "A"],
        ["C", "D", "A", "B"],
        ["D", "A", "B", "C"],
        ["A", "B", "C", "D"],
      ],
    );
  });

  it("passes the rotated roster to the official CLI", () => {
    const options = parseBatchOptions([
      ...SNAKES.flatMap((snake) => ["--snake", snake]),
    ]);
    const args = buildBattlesnakeArguments(
      options,
      100,
      "/tmp/game.jsonl",
      2,
    );
    const names = args.flatMap((value, index) =>
      value === "--name" ? [args[index + 1]] : []
    );
    assert.deepEqual(names, ["C", "D", "A", "B"]);
  });

  it("continues roster rotation from a managed lane's global offset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nicanelo-rotation-"));
    try {
      await assert.rejects(
        runBatch({
          games: 2,
          baseSeed: 100,
          gameIndexOffset: 2,
          outputDirectory: directory,
          runId: "rotation-test",
          timeoutMs: 500,
          battlesnakeBinary: "/usr/bin/false",
          snakes: SNAKES.map((value) => {
            const [name, url] = value.split("=") as [string, string];
            return { name, url };
          }),
        }),
        /2 of 2 gym games failed/,
      );
      const entries = (await readFile(join(directory, "manifest.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { snakeOrder: string[] });
      assert.deepEqual(entries.map((entry) => entry.snakeOrder), [
        ["C", "D", "A", "B"],
        ["D", "A", "B", "C"],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a failed game the configured number of times", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nicanelo-retries-"));
    try {
      await assert.rejects(
        runBatch({
          games: 1,
          gameAttempts: 3,
          baseSeed: 500,
          outputDirectory: directory,
          runId: "retry-test",
          timeoutMs: 500,
          battlesnakeBinary: "/usr/bin/false",
          snakes: SNAKES.map((value) => {
            const [name, url] = value.split("=") as [string, string];
            return { name, url };
          }),
        }),
        /1 of 1 gym games failed/,
      );
      const entry = JSON.parse(
        (await readFile(join(directory, "manifest.jsonl"), "utf8")).trim(),
      ) as { attempts: number; success: boolean };
      assert.equal(entry.success, false);
      assert.equal(entry.attempts, 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only a JSON object as portable run provenance", () => {
    assert.deepEqual(
      parseRunProvenance('{"source":"snake-zoo","commit":"abc123"}'),
      { source: "snake-zoo", commit: "abc123" },
    );
    assert.throws(
      () => parseRunProvenance('["snake-zoo"]'),
      /must be a JSON object/,
    );
  });
});
