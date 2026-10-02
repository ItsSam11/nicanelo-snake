import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseTrainModelOptions,
} from "../src/training/train-model.js";
import { parsePrepareTrainingDatasetOptions } from "../src/training/prepare-training-dataset.js";
import { parseTrainPreparedModelOptions } from "../src/training/train-prepared-model.js";

describe("model training CLI", () => {
  it("requires an immutable corpus manifest", () => {
    const options = parseTrainModelOptions([
      "--corpus-manifest",
      "data/telemetry/corpus/v1/manifest.jsonl",
      "--model-version",
      "candidate-v1",
    ]);

    assert.equal(
      options.corpusManifest,
      "data/telemetry/corpus/v1/manifest.jsonl",
    );
    assert.throws(
      () => parseTrainModelOptions(["--model-version", "candidate-v1"]),
      /--corpus-manifest is required/,
    );
  });

  it("parses prepared dataset and worker options", () => {
    const preparation = parsePrepareTrainingDatasetOptions([
      "--corpus-manifest",
      "corpus.jsonl",
      "--output",
      "prepared/v2",
      "--workers",
      "4",
      "--max-games",
      "10",
    ]);
    assert.equal(preparation.workers, 4);
    assert.equal(preparation.maximumGames, 10);

    const training = parseTrainPreparedModelOptions([
      "--dataset-manifest",
      "prepared/v2/manifest.json",
      "--model-version",
      "nicanelo-v2",
      "--workers",
      "8",
    ]);
    assert.equal(training.workers, 8);
    assert.equal(training.epochs, 200);
  });
});
