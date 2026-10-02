import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STRATEGY_FEATURE_SET_VERSION } from "../src/model/feature-set.js";
import {
  DEFAULT_STRATEGY_MODEL,
  loadStrategyModel,
  loadStrategyModelFromEnvironment,
  modelSearchOptions,
  parseStrategyModel,
} from "../src/model/strategy-model.js";

describe("versioned strategy model", () => {
  it("loads the checked-in baseline artifact", async () => {
    const model = await loadStrategyModel("models/heuristic-puct-v1.json");

    assert.equal(model.modelVersion, "heuristic-puct-v1");
    assert.equal(model.training.method, "baseline");
    assert.equal(modelSearchOptions(model).puctConstant, 1.25);
    assert.equal(modelSearchOptions(model).valueBias, 0);
    assert.equal(
      modelSearchOptions(model).policyPrior?.weights?.headSafety,
      3.5,
    );
  });

  it("loads the adaptive tournament baseline with bounded safety", async () => {
    const model = await loadStrategyModel(
      "models/candidates/nicanelo-tournament-r1-20260920-v1.json",
    );

    assert.equal(model.modelVersion, "nicanelo-tournament-r1-20260920-v1");
    assert.equal(model.training.featureSetVersion, STRATEGY_FEATURE_SET_VERSION);
    assert.equal(model.evaluationWeights.territory, 60);
    assert.equal(model.evaluationWeights.opponentPressure, 36);
    assert.equal(model.policyPrior.weights.contextualAggression, 1.75);
    assert.equal(model.policyPrior.weights.contextualConservatism, 1.4);
  });

  it("loads the adaptive control baseline with strategic weight headroom", async () => {
    const model = await loadStrategyModel(
      "models/heuristic-adaptive-control-v1.json",
    );

    assert.equal(model.modelVersion, "heuristic-adaptive-control-v1");
    assert.equal(model.training.featureSetVersion, STRATEGY_FEATURE_SET_VERSION);
    assert.equal(model.evaluationWeights.territory, 75);
    assert.equal(model.evaluationWeights.headToHead, 90);
    assert.equal(model.evaluationWeights.opponentPressure, 54);
    assert.equal(model.evaluationWeights.trapSafety, 55);
    assert.equal(model.policyPrior.weights.headSafety, 5);
    assert.equal(modelSearchOptions(model).puctConstant, 1.15);
    assert.equal(DEFAULT_STRATEGY_MODEL.modelVersion, model.modelVersion);
    assert.deepEqual(DEFAULT_STRATEGY_MODEL, model);
  });

  it("labels the baseline with the current semantic feature set", () => {
    assert.equal(
      DEFAULT_STRATEGY_MODEL.training.featureSetVersion,
      STRATEGY_FEATURE_SET_VERSION,
    );
  });

  it("rejects incompatible or unsafe artifacts", () => {
    assert.throws(
      () => parseStrategyModel({ ...DEFAULT_STRATEGY_MODEL, schemaVersion: 1 }),
      /Unsupported strategy model schema/,
    );
    assert.throws(
      () => parseStrategyModel({
        ...DEFAULT_STRATEGY_MODEL,
        search: { puctConstant: 0 },
      }),
      /puctConstant must be positive/,
    );
    assert.throws(
      () => parseStrategyModel({
        ...DEFAULT_STRATEGY_MODEL,
        search: { puctConstant: 1.25, valueBias: Number.NaN },
      }),
      /valueBias must be a finite number/,
    );
    assert.throws(
      () => parseStrategyModel({
        ...DEFAULT_STRATEGY_MODEL,
        evaluationWeights: {
          ...DEFAULT_STRATEGY_MODEL.evaluationWeights,
          lengthAdvantage: 151,
        },
      }),
      /Unsafe learned evaluation weights: lengthAdvantage/,
    );
    assert.throws(
      () => parseStrategyModel({
        ...DEFAULT_STRATEGY_MODEL,
        training: {
          ...DEFAULT_STRATEGY_MODEL.training,
          method: "softmax-gradient",
          featureSetVersion: "offense-food-v1",
        },
      }),
      /Model feature set offense-food-v1 is incompatible/,
    );
  });

  it("fails closed when an explicitly configured model cannot load", async () => {
    const previous = process.env.MODEL_PATH;
    process.env.MODEL_PATH = "/missing/nicanelo-model.json";
    const events: Readonly<Record<string, unknown>>[] = [];
    try {
      await assert.rejects(
        loadStrategyModelFromEnvironment((entry) => events.push(entry)),
        /Configured strategy model could not be loaded/,
      );
      assert.equal(events[0]?.event, "model_load_error");
    } finally {
      if (previous === undefined) delete process.env.MODEL_PATH;
      else process.env.MODEL_PATH = previous;
    }
  });

  it("refuses to serve a configured model that failed its offline gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snake-model-gate-"));
    const path = join(directory, "candidate.json");
    const previous = process.env.MODEL_PATH;
    await writeFile(path, JSON.stringify({
      ...DEFAULT_STRATEGY_MODEL,
      training: {
        ...DEFAULT_STRATEGY_MODEL.training,
        offlineGatePassed: false,
      },
    }));
    process.env.MODEL_PATH = path;
    try {
      await assert.rejects(
        loadStrategyModelFromEnvironment(() => undefined),
        /did not pass its offline promotion gate/,
      );
    } finally {
      if (previous === undefined) delete process.env.MODEL_PATH;
      else process.env.MODEL_PATH = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
