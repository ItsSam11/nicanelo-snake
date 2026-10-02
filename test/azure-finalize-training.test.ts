import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRATEGY_FEATURE_SET_VERSION } from "../src/model/feature-set.js";
import { PUCT_POLICY_TARGET_VERSION } from "../src/training/search-targets.js";
import { validatePreparationProvenance } from "../src/training/azure-finalize-training.js";
import {
  POLICY_FEATURE_NAMES,
  VALUE_FEATURE_NAMES,
} from "../src/training/model-training.js";
import {
  POLICY_CANDIDATE_LIMIT,
  POLICY_RECORD_DOUBLES,
  PREPARED_TRAINING_SCHEMA_VERSION,
  VALUE_RECORD_DOUBLES,
} from "../src/training/prepared-training-format.js";

function provenance(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    preparedTrainingSchemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
    featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
    policyTargetVersion: PUCT_POLICY_TARGET_VERSION,
    policyFeatureNames: [...POLICY_FEATURE_NAMES],
    valueFeatureNames: [...VALUE_FEATURE_NAMES],
    binaryFormat: {
      numberType: "float64-le",
      policyRecordDoubles: POLICY_RECORD_DOUBLES,
      valueRecordDoubles: VALUE_RECORD_DOUBLES,
      maximumPolicyCandidates: POLICY_CANDIDATE_LIMIT,
    },
  };
}

describe("Azure prepared-training provenance", () => {
  it("accepts only the exact current feature and binary layout", () => {
    assert.doesNotThrow(() => validatePreparationProvenance(provenance()));

    assert.throws(
      () => validatePreparationProvenance({
        ...provenance(),
        featureSetVersion: "offense-food-v2",
      }),
      /incompatible with the current training format/u,
    );
    assert.throws(
      () => validatePreparationProvenance({
        ...provenance(),
        binaryFormat: {
          ...(provenance().binaryFormat as Record<string, unknown>),
          valueRecordDoubles: VALUE_RECORD_DOUBLES - 1,
        },
      }),
      /incompatible with the current training format/u,
    );
  });
});
