import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPairedShardProvenance,
  parseOptions,
  parseShardMarker,
  type ShardMarker,
} from "../src/training/azure-paired-model-evaluation.js";

describe("Azure paired evaluation account configuration", () => {
  const requiredArguments = [
    "--baseline-prefix", "telemetry/raw/gym/baseline",
    "--candidate-prefix", "telemetry/raw/gym/candidate",
    "--candidate-model-version", "candidate-model",
  ];

  it("requires an explicit account instead of connecting to a fixed deployment", () => {
    for (const environment of [{}, { AZURE_STORAGE_ACCOUNT_URL: "  " }]) {
      assert.throws(
        () => parseOptions(requiredArguments, environment),
        /--account-url or AZURE_STORAGE_ACCOUNT_URL is required/u,
      );
    }
  });

  it("uses the local account and lets the CLI override it", () => {
    const environment = {
      AZURE_STORAGE_ACCOUNT_URL: " https://storage.example.com ",
    };
    assert.equal(
      parseOptions(requiredArguments, environment).accountUrl,
      "https://storage.example.com",
    );
    assert.equal(
      parseOptions([
        ...requiredArguments, "--account-url", "https://override.example.com",
      ], environment).accountUrl,
      "https://override.example.com",
    );
  });
});

function marker(side: "baseline" | "candidate"): ShardMarker {
  const candidate = side === "candidate";
  return {
    games: 50,
    lanes: 5,
    uniqueSeeds: 50,
    uniqueGameIds: 50,
    roster: ["Nicanelo", "A", "B", "C"],
    subjectModelVersion: "heuristic-adaptive-control-v1",
    baseSeed: 2_027_300_000,
    gameIndexOffset: 0,
    provenance: {
      campaignId: candidate ? "candidate-campaign" : "baseline-campaign",
      computePool: candidate ? "pool-b" : "pool-a",
      cohort: "challenger",
      engineVersion: "adaptive-posture-v4",
      subjectModelVersion: "heuristic-adaptive-control-v1",
      subjectModelSha256: "model-sha",
      jobImageDigest: "sha256:image",
      searchTimeBudgetMs: 350,
      searchResponseReserveMs: 100,
      strategicRootPrior: true,
      rootSafetyArbiter: candidate,
      rootBranchingReserve: candidate,
      zoo: {
        hobbs: { commit: "one" },
        snork: { commit: "two" },
      },
    },
  };
}

describe("Azure paired model provenance", () => {
  it("accepts only the intended root-safety flag changes", () => {
    assert.doesNotThrow(() =>
      assertPairedShardProvenance(
        marker("baseline"),
        marker("candidate"),
        "challenger|1",
      )
    );
  });

  it("rejects causal input differences between paired shards", () => {
    const cases: readonly {
      field: string;
      mutate: (value: ShardMarker) => void;
    }[] = [
      {
        field: "jobImageDigest",
        mutate: (value) => {
          (value.provenance as Record<string, unknown>).jobImageDigest =
            "sha256:different";
        },
      },
      {
        field: "subjectModelSha256",
        mutate: (value) => {
          (value.provenance as Record<string, unknown>).subjectModelSha256 =
            "different-model";
        },
      },
      {
        field: "searchTimeBudgetMs",
        mutate: (value) => {
          (value.provenance as Record<string, unknown>).searchTimeBudgetMs = 400;
        },
      },
      {
        field: "searchResponseReserveMs",
        mutate: (value) => {
          (value.provenance as Record<string, unknown>)
            .searchResponseReserveMs = 80;
        },
      },
      {
        field: "zoo",
        mutate: (value) => {
          (value.provenance.zoo as { hobbs: { commit: string } })
            .hobbs.commit = "different";
        },
      },
      {
        field: "roster",
        mutate: (value) => {
          value.roster = ["Nicanelo", "B", "A", "C"];
        },
      },
      {
        field: "baseSeed",
        mutate: (value) => {
          value.baseSeed += 1;
        },
      },
      {
        field: "gameIndexOffset",
        mutate: (value) => {
          value.gameIndexOffset += 50;
        },
      },
      {
        field: "lanes",
        mutate: (value) => {
          value.lanes = 4;
        },
      },
    ];

    for (const testCase of cases) {
      const candidate = marker("candidate");
      testCase.mutate(candidate);
      assert.throws(
        () => assertPairedShardProvenance(
          marker("baseline"),
          candidate,
          "challenger|1",
        ),
        new RegExp(testCase.field, "u"),
        testCase.field,
      );
    }
  });

  it("fails closed when either side has unexpected experiment flags", () => {
    const baseline = marker("baseline");
    (baseline.provenance as Record<string, unknown>).rootSafetyArbiter = true;
    assert.throws(
      () => assertPairedShardProvenance(
        baseline,
        marker("candidate"),
        "legacy|1",
      ),
      /baseline.*rootSafetyArbiter/u,
    );

    const candidate = marker("candidate");
    (candidate.provenance as Record<string, unknown>).rootBranchingReserve = false;
    assert.throws(
      () => assertPairedShardProvenance(
        marker("baseline"),
        candidate,
        "legacy|1",
      ),
      /candidate.*rootBranchingReserve/u,
    );
  });

  it("requires marker-level roster, lanes, and provenance", () => {
    const valid = marker("baseline");
    assert.deepEqual(
      parseShardMarker(JSON.stringify(valid), "valid/summary.json"),
      valid,
    );
    const invalid = { ...valid } as Partial<ShardMarker>;
    delete invalid.provenance;
    assert.throws(
      () => parseShardMarker(JSON.stringify(invalid), "bad/summary.json"),
      /bad\/summary\.json is not a valid shard marker/u,
    );
  });
});
