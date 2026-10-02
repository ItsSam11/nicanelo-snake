import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STRATEGY_FEATURE_SET_VERSION } from "../src/model/feature-set.js";
import type { Battlesnake, Direction, GameState } from "../src/api/types.js";
import {
  loadTrainingCorpusManifest,
  manifestEntry,
} from "../src/training/corpus-manifest.js";
import {
  selectAzureTrainingGames,
  type AzureTrainingSelectionCandidate,
} from "../src/training/azure-training-selection.js";
import { trainStrategyModel } from "../src/training/model-training.js";
import {
  prepareTrainingDataset,
  trainPreparedStrategyModel,
} from "../src/training/prepared-training.js";
import { PreparedTrainingShardWriter } from
  "../src/training/prepared-training-shard.js";
import {
  buildProfileReference,
  profilePercentiles,
  profileReferenceDigest,
  serializeProfileReference,
} from "../src/training/profile-reference.js";
import {
  buildReplayCorpus,
  serializeOfficialReplay,
  type OfficialReplay,
} from "../src/training/replay-corpus.js";
import { gameState, opponent } from "./fixtures.js";

function moved(snake: Battlesnake, move: Direction): Battlesnake {
  const offsets = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  } as const;
  const offset = offsets[move];
  const head = { x: snake.head.x + offset.x, y: snake.head.y + offset.y };
  const body = [head, ...snake.body.slice(0, -1)];
  return { ...snake, head, body, length: body.length, latency: "1" };
}

function stateWithSnakes(
  state: GameState,
  turn: number,
  snakes: Battlesnake[],
): GameState {
  return {
    ...state,
    turn,
    board: { ...state.board, snakes },
    you: snakes.find((snake) => snake.id === "us") ?? snakes[0] ?? state.you,
  };
}

function replay(gameId: string, winnerId: string): OfficialReplay {
  const initialBase = gameState({
    youBody: [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }],
    opponents: [
      opponent("a", [{ x: 9, y: 9 }, { x: 9, y: 10 }, { x: 10, y: 10 }]),
      opponent("b", [{ x: 1, y: 9 }, { x: 1, y: 10 }, { x: 0, y: 10 }]),
      opponent("c", [{ x: 9, y: 1 }, { x: 9, y: 0 }, { x: 10, y: 0 }]),
    ],
  });
  const metadata = { ...initialBase.game, id: gameId };
  const initial = { ...initialBase, game: metadata };
  const turnOneSnakes = [
    moved(initial.board.snakes[0]!, "right"),
    moved(initial.board.snakes[1]!, "left"),
    moved(initial.board.snakes[2]!, "down"),
    moved(initial.board.snakes[3]!, "up"),
  ];
  const turnOne = stateWithSnakes(initial, 11, turnOneSnakes);
  const winningSnake = turnOneSnakes.find((snake) => snake.id === winnerId)!;
  const final = stateWithSnakes(initial, 12, [moved(winningSnake, "up")]);
  return {
    metadata,
    states: [initial, turnOne, final],
    result: { winnerId, winnerName: winnerId, isDraw: false },
  };
}

function assertClose(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) <= 1e-12,
    `${actual} differs from ${expected}`,
  );
}

describe("prepared multithreaded training", () => {
  it("reports the exact worker output directory used for consolidation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snake-prepared-shard-"));
    try {
      const output = join(directory, "shard-0001");
      const writer = new PreparedTrainingShardWriter(output, 1);
      await writer.open();
      const shard = await writer.close();
      assert.equal(shard.directory, "shard-0001");
      assert.equal(Object.keys(shard.files).length, 6);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates balanced, nested, disjoint Azure dataset roles", () => {
    const candidates = (["legacy", "challenger"] as const).flatMap((cohort) =>
      Array.from({ length: 30 }, (_, index): AzureTrainingSelectionCandidate => ({
        gameId: `${cohort}-${index.toString().padStart(2, "0")}`,
        cohort,
        finalTurn: 50 + index,
        winnerName: index % 2 === 0 ? "Nicanelo" : "Opponent",
        isDraw: false,
        record: {
          name: `${cohort}/${index}/record.jsonl`,
          etag: `record-${index}`,
          contentLength: 100,
        },
        summary: {
          name: `${cohort}/${index}/summary.json`,
          etag: `summary-${index}`,
          contentLength: 10,
        },
        searchObservations: {
          name: `${cohort}/${index}/search-observations.jsonl`,
          etag: `search-${index}`,
          contentLength: 50,
        },
      }))
    );
    const options = {
      selectionId: "selection-test",
      pilotGamesPerCohort: 3,
      mainGamesPerCohort: 10,
      validationGamesPerCohort: 2,
      testGamesPerCohort: 2,
      preparationShards: 4,
    } as const;
    const selected = selectAzureTrainingGames(candidates, options);
    const repeated = selectAzureTrainingGames([...candidates].reverse(), options);
    assert.deepEqual(repeated, selected);
    assert.equal(
      selected.filter((entry) => entry.roles.includes("train-pilot")).length,
      6,
    );
    assert.equal(
      selected.filter((entry) => entry.roles.includes("train-main")).length,
      20,
    );
    assert.equal(
      selected.filter((entry) => entry.roles.includes("validation")).length,
      4,
    );
    assert.equal(
      selected.filter((entry) => entry.roles.includes("test")).length,
      4,
    );
    assert.ok(selected.every((entry) =>
      !entry.roles.includes("train-pilot") || entry.roles.includes("train-main")
    ));
    assert.ok(selected.every((entry) =>
      entry.preparationShard >= 0 && entry.preparationShard < 4
    ));
  });

  it("preserves the in-memory trainer result while sharding work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snake-prepared-training-"));
    try {
      const sources = [
        replay("prepared-a", "us"),
        replay("prepared-b", "a"),
        replay("prepared-c", "us"),
        replay("prepared-d", "b"),
      ];
      const summaries = sources.map((source) =>
        buildReplayCorpus(source, { source: "gym" }).summary
      );
      const reference = buildProfileReference(
        summaries.flatMap((summary) => summary.profiles),
        "prepared-reference-v1",
        "2026-09-18T00:00:00.000Z",
      );
      await writeFile(
        join(directory, "profile-reference.json"),
        serializeProfileReference(reference),
      );
      const entries = [];
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index]!;
        const summary = summaries[index]!;
        const gameDirectory = join(directory, source.metadata.id);
        await mkdir(gameDirectory);
        const recordText = serializeOfficialReplay(source);
        const summaryText = `${JSON.stringify(summary)}\n`;
        await Promise.all([
          writeFile(join(gameDirectory, "record.jsonl"), recordText),
          writeFile(join(gameDirectory, "summary.json"), summaryText),
        ]);
        entries.push(manifestEntry(
          summary,
          `${source.metadata.id}/record.jsonl`,
          `${source.metadata.id}/summary.json`,
          recordText,
          summaryText,
          {
            version: reference.referenceVersion,
            path: "profile-reference.json",
            digest: profileReferenceDigest(reference),
          },
          summary.profiles.map((profile) => ({
            snakeId: profile.snakeId,
            snakeName: profile.snakeName,
            dominantProfile: profile.dominantProfile,
            rawScores: { ...profile.scores },
            percentileScores: profilePercentiles(profile.scores, reference),
            confidence: profile.confidence.overall,
          })),
          {
            selectorVersion: "corpus-selector-v2",
            selected: true,
            quality: 0.8,
            coverage: 0.7,
            diversity: 1,
            decisionDensity: 0.6,
            selectionScore: 0.75,
            samplingWeight: 1 + index / 10,
            coverageTags: ["source:gym"],
            exclusionReasons: [],
          },
        ));
      }
      const manifestPath = join(directory, "manifest.jsonl");
      await writeFile(
        manifestPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const createdAt = "2026-09-18T01:00:00.000Z";
      const baseline = trainStrategyModel(
        await loadTrainingCorpusManifest(manifestPath),
        {
          modelVersion: "prepared-test",
          createdAt,
          minimumGames: 4,
          epochs: 8,
        },
      );
      const prepared = await prepareTrainingDataset({
        corpusManifest: manifestPath,
        outputDirectory: join(directory, "prepared"),
        workers: 2,
        createdAt,
      });
      const result = await trainPreparedStrategyModel({
        datasetManifest: prepared.manifestPath,
        outputPath: join(directory, "candidate.json"),
        modelVersion: "prepared-test",
        createdAt,
        minimumGames: 4,
        epochs: 8,
        workers: 2,
      });

      assert.equal(
        prepared.dataset.featureSetVersion,
        STRATEGY_FEATURE_SET_VERSION,
      );
      assert.equal(
        result.model.training.featureSetVersion,
        STRATEGY_FEATURE_SET_VERSION,
      );

      for (const name of Object.keys(baseline.opponentPolicy.weights) as
        (keyof typeof baseline.opponentPolicy.weights)[]) {
        assertClose(
          result.model.opponentPolicy.weights[name],
          baseline.opponentPolicy.weights[name],
        );
      }
      for (const name of Object.keys(baseline.evaluationWeights) as
        (keyof typeof baseline.evaluationWeights)[]) {
        assertClose(
          result.model.evaluationWeights[name],
          baseline.evaluationWeights[name],
        );
      }
      assert.equal(
        result.model.training.trainingSamples,
        baseline.training.trainingSamples,
      );
      assert.equal(
        result.model.training.validationSamples,
        baseline.training.validationSamples,
      );
      assert.equal(
        result.model.training.offlineGatePassed,
        baseline.training.offlineGatePassed,
      );
      assert.equal(result.workers, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
