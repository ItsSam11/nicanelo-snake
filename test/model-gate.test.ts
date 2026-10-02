import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateTournamentGate,
  parseManifestJsonl,
} from "../src/training/model-gate.js";

function manifest(winnerName: string, p95Ms: number): string {
  return JSON.stringify({
    success: true,
    summary: {
      winnerName,
      isDraw: false,
      eliminations: [
        { snakeName: "Candidate" },
        { snakeName: "Baseline-A" },
        { snakeName: "Baseline-B" },
        { snakeName: "Baseline-C" },
      ],
      latency: [
        { snakeName: "Candidate", p95Ms },
        { snakeName: "Baseline-A", p95Ms: 10 },
      ],
    },
  });
}

describe("model tournament gate", () => {
  it("passes only when sample, win-rate, and latency thresholds hold", () => {
    const entries = parseManifestJsonl([
      manifest("Candidate", 30),
      manifest("Baseline-A", 40),
      manifest("Candidate", 35),
    ].join("\n"));
    const result = evaluateTournamentGate(entries, {
      candidateNames: ["Candidate"],
      minimumGames: 3,
      minimumWinRate: 0.5,
      maximumP95LatencyMs: 50,
    });

    assert.equal(result.passed, true);
    assert.equal(result.games, 3);
    assert.equal(result.wins, 2);
    assert.equal(result.maximumObservedP95Ms, 40);
  });

  it("reports every failed promotion condition", () => {
    const result = evaluateTournamentGate(
      parseManifestJsonl(manifest("Baseline-A", 300)),
      {
        candidateNames: ["Candidate"],
        minimumGames: 3,
        minimumWinRate: 0.5,
        maximumP95LatencyMs: 250,
      },
    );

    assert.equal(result.passed, false);
    assert.equal(result.reasons.length, 3);
  });
});
