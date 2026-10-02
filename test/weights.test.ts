import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  constrainLearnedEvaluationWeights,
  DEFAULT_EVALUATION_WEIGHTS,
  LEARNED_EVALUATION_WEIGHT_BOUNDS,
  MINIMUM_SAFETY_WEIGHT_BUDGET,
  MINIMUM_SAFETY_WEIGHT_BUDGET_RATIO,
  resolveEvaluationWeights,
  SAFETY_WEIGHT_NAMES,
  unsafeLearnedEvaluationWeights,
} from "../src/evaluation/weights.js";

describe("resolveEvaluationWeights", () => {
  it("overrides selected weights without mutating defaults", () => {
    const resolved = resolveEvaluationWeights({ health: 99 });

    assert.equal(resolved.health, 99);
    assert.equal(resolved.territory, DEFAULT_EVALUATION_WEIGHTS.territory);
    assert.notEqual(DEFAULT_EVALUATION_WEIGHTS.health, 99);
  });

  it("rejects non-finite values", () => {
    assert.throws(
      () => resolveEvaluationWeights({ health: Number.NaN }),
      /must be a finite number/,
    );
  });

  it("keeps learned control weights inside semantic safety bounds", () => {
    const constrained = constrainLearnedEvaluationWeights({
      ...DEFAULT_EVALUATION_WEIGHTS,
      reachableSpace: -19,
      relativeSpace: -41,
      health: -32,
      lengthAdvantage: 151,
      mobility: -20,
      opponentPressure: 0.2,
      tailAccess: -43,
    });

    assert.ok(
      constrained.reachableSpace >=
        LEARNED_EVALUATION_WEIGHT_BOUNDS.reachableSpace.minimum,
    );
    assert.equal(
      constrained.lengthAdvantage,
      LEARNED_EVALUATION_WEIGHT_BOUNDS.lengthAdvantage.maximum,
    );
    assert.equal(
      constrained.opponentPressure,
      LEARNED_EVALUATION_WEIGHT_BOUNDS.opponentPressure.minimum,
    );
    const safetyBudget = SAFETY_WEIGHT_NAMES.reduce(
      (sum, name) => sum + constrained[name],
      0,
    );
    assert.ok(Math.abs(safetyBudget - MINIMUM_SAFETY_WEIGHT_BUDGET) < 1e-9);
    assert.deepEqual(unsafeLearnedEvaluationWeights(constrained), []);
  });

  it("reserves safety without pinning learning to the conservative baseline", () => {
    assert.equal(MINIMUM_SAFETY_WEIGHT_BUDGET_RATIO, 0.75);
    assert.equal(MINIMUM_SAFETY_WEIGHT_BUDGET, 135);

    const constrained = constrainLearnedEvaluationWeights({
      ...DEFAULT_EVALUATION_WEIGHTS,
      reachableSpace: -1_000,
      relativeSpace: -1_000,
      mobility: -1_000,
      tailAccess: -1_000,
      trapSafety: -1_000,
      territory: 1_000,
      headToHead: 1_000,
      opponentPressure: 1_000,
    });
    const safetyBudget = SAFETY_WEIGHT_NAMES.reduce(
      (sum, name) => sum + constrained[name],
      0,
    );

    assert.ok(Math.abs(safetyBudget - MINIMUM_SAFETY_WEIGHT_BUDGET) < 1e-9);
    assert.equal(constrained.territory, 90);
    assert.equal(constrained.headToHead, 100);
    assert.equal(constrained.opponentPressure, 72);
    assert.deepEqual(unsafeLearnedEvaluationWeights(constrained), []);
  });

  it("reports inverted safety weights as unsafe", () => {
    const unsafe = unsafeLearnedEvaluationWeights({
      ...DEFAULT_EVALUATION_WEIGHTS,
      mobility: -1,
      tailAccess: -1,
    });

    assert.deepEqual(unsafe, ["mobility", "tailAccess"]);
  });

  it("rejects a coordinated collapse across individually legal safety weights", () => {
    const collapsed = {
      ...DEFAULT_EVALUATION_WEIGHTS,
      reachableSpace: LEARNED_EVALUATION_WEIGHT_BOUNDS.reachableSpace.minimum,
      relativeSpace: LEARNED_EVALUATION_WEIGHT_BOUNDS.relativeSpace.minimum,
      mobility: LEARNED_EVALUATION_WEIGHT_BOUNDS.mobility.minimum,
      tailAccess: LEARNED_EVALUATION_WEIGHT_BOUNDS.tailAccess.minimum,
      trapSafety: LEARNED_EVALUATION_WEIGHT_BOUNDS.trapSafety.minimum,
    };

    assert.deepEqual(unsafeLearnedEvaluationWeights(collapsed), ["safetyBudget"]);
  });
});
