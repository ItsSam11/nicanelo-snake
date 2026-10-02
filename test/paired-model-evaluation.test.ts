import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluatePairedModels,
  type CohortSummary,
  type PairedGameSummary,
} from "../src/training/paired-model-evaluation.js";

function summary(
  seed: number,
  winnerName: string,
  p95Ms = 40,
): PairedGameSummary {
  return {
    seed,
    ruleset: "standard",
    map: "standard",
    width: 11,
    height: 11,
    initialSnakeCount: 4,
    winnerName,
    isDraw: winnerName === "draw",
    finalTurn: 80,
    profiles: [
      { snakeName: "Nicanelo" },
      { snakeName: "A" },
      { snakeName: "B" },
      { snakeName: "C" },
    ],
    latency: [{ snakeName: "Nicanelo", p95Ms, maxMs: p95Ms + 10 }],
  };
}

function entry(cohort: string, value: PairedGameSummary): CohortSummary {
  return { cohort, summary: value };
}

describe("paired model evaluation", () => {
  it("measures paired gains and regressions per cohort and combined", () => {
    const baseline = [
      entry("challenger", summary(1, "A")),
      entry("challenger", summary(2, "Nicanelo")),
      entry("legacy", summary(3, "B")),
      entry("legacy", summary(4, "Nicanelo")),
    ];
    const candidate = [
      entry("challenger", summary(1, "Nicanelo", 30)),
      entry("challenger", summary(2, "Nicanelo", 40)),
      entry("legacy", summary(3, "B", 50)),
      entry("legacy", summary(4, "C", 60)),
    ];

    const result = evaluatePairedModels(baseline, candidate);
    assert.equal(result.games, 4);
    assert.equal(result.combined.gainedWins, 1);
    assert.equal(result.combined.lostWins, 1);
    assert.equal(result.combined.candidateWinRateDelta, 0);
    assert.equal(result.combined.candidateLatencyMs.p95OfGameP95, 60);
    assert.deepEqual(result.cohorts.map((item) => item.cohort), [
      "challenger",
      "legacy",
    ]);
  });

  it("rejects a comparison when the seed exists under a different roster", () => {
    const baseline = [entry("legacy", summary(1, "A"))];
    const changed = summary(1, "A");
    changed.profiles = [{ snakeName: "Nicanelo" }, { snakeName: "Different" }];

    assert.throws(
      () => evaluatePairedModels(baseline, [entry("legacy", changed)]),
      /Scenario differs/u,
    );
  });

  it("rejects the same roster when the seat order differs", () => {
    const baselineSummary = summary(1, "A");
    const candidateSummary = summary(1, "A");
    candidateSummary.profiles = [
      candidateSummary.profiles[1]!,
      candidateSummary.profiles[0]!,
      ...candidateSummary.profiles.slice(2),
    ];

    assert.throws(
      () => evaluatePairedModels(
        [entry("challenger", baselineSummary)],
        [entry("challenger", candidateSummary)],
      ),
      /Scenario differs/u,
    );
  });

  it("uses the manifest seat order when it is available", () => {
    const baselineSummary = summary(1, "A");
    const candidateSummary = summary(1, "A");
    baselineSummary.snakeOrder = ["Nicanelo", "A", "B", "C"];
    candidateSummary.snakeOrder = ["A", "Nicanelo", "B", "C"];

    assert.throws(
      () => evaluatePairedModels(
        [entry("challenger", baselineSummary)],
        [entry("challenger", candidateSummary)],
      ),
      /Scenario differs/u,
    );
  });
});
