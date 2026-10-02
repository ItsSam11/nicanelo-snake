import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalStateKey } from "../src/search/state-key.js";
import { PUCT_POLICY_TARGET_VERSION } from "../src/training/search-targets.js";
import type { OfficialReplay } from "../src/training/replay-corpus.js";
import {
  ELIGIBILITY_POLICY_VERSION,
  evaluateEligibility,
  loadCorpusManifest,
  loadTrainingCorpusManifest,
  manifestEntry,
} from "../src/training/corpus-manifest.js";
import {
  buildReplayCorpus,
  serializeOfficialReplay,
} from "../src/training/replay-corpus.js";
import {
  buildProfileReference,
  profilePercentiles,
  profileReferenceDigest,
  serializeProfileReference,
} from "../src/training/profile-reference.js";
import { gameState, opponent } from "./fixtures.js";

function replay(initialSnakeCount = 4): OfficialReplay {
  const initial = gameState({
    opponents: [
      opponent("a", [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }]),
      opponent("b", [{ x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 }]),
      opponent("c", [{ x: 1, y: 9 }, { x: 1, y: 8 }, { x: 1, y: 7 }]),
    ].slice(0, initialSnakeCount - 1),
  });
  const current = initial.board.snakes[0]!;
  const head = { x: current.head.x, y: current.head.y + 1 };
  const winner = {
    ...current,
    head,
    body: [head, ...current.body.slice(0, -1)],
  };
  const final = {
    ...initial,
    turn: initial.turn + 1,
    board: { ...initial.board, snakes: [winner] },
    you: winner,
  };
  return {
    metadata: initial.game,
    states: [initial, final],
    result: { winnerId: winner.id, winnerName: winner.name, isDraw: false },
  };
}

function manifestMetadata(summary: ReturnType<typeof buildReplayCorpus>["summary"]) {
  const reference = buildProfileReference(
    summary.profiles,
    "profile-reference-test",
    "2026-09-17T00:00:00.000Z",
  );
  const assignments = summary.profiles.map((profile) => ({
    snakeId: profile.snakeId,
    snakeName: profile.snakeName,
    dominantProfile: profile.dominantProfile,
    rawScores: { ...profile.scores },
    percentileScores: profilePercentiles(profile.scores, reference),
    confidence: profile.confidence.overall,
  }));
  const selection = {
    selectorVersion: "corpus-selector-v2",
    selected: true,
    quality: 0.8,
    coverage: 0.7,
    diversity: 1,
    decisionDensity: 0.4,
    selectionScore: 0.75,
    samplingWeight: 1,
    coverageTags: ["source:gym"],
    exclusionReasons: [],
  } as const;
  return {
    reference,
    referenceMetadata: {
      version: reference.referenceVersion,
      path: "profile-reference.json",
      digest: profileReferenceDigest(reference),
    },
    assignments,
    selection,
  };
}

describe("versioned corpus manifests", () => {
  it("admits summaries with two to four initial snakes", () => {
    const summary = buildReplayCorpus(replay(), { source: "gym" }).summary;

    for (const count of [2, 3, 4]) {
      const decision = evaluateEligibility({
        ...summary,
        initialSnakeCount: count,
        profiles: summary.profiles.slice(0, count),
      });
      assert.equal(decision.eligible, true);
      assert.equal(decision.policyVersion, "championship-eligibility-v3");
      assert.equal(decision.policyVersion, ELIGIBILITY_POLICY_VERSION);
    }
  });

  it("rejects initial snake counts outside the supported range", () => {
    const summary = buildReplayCorpus(replay(), { source: "gym" }).summary;

    for (const count of [1, 5, 2.5]) {
      const decision = evaluateEligibility({
        ...summary,
        initialSnakeCount: count,
      });
      assert.equal(decision.eligible, false);
      assert.ok(
        decision.rejectionReasons.includes(
          "initial-snake-count-out-of-range",
        ),
      );
    }
  });

  it("admits valid games and verifies immutable record digests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snake-corpus-"));
    try {
      const source = replay(2);
      const recordText = serializeOfficialReplay(source);
      const summary = buildReplayCorpus(source, { source: "gym" }).summary;
      const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
      const metadata = manifestMetadata(summary);
      const entry = manifestEntry(
        summary,
        "record.jsonl",
        "summary.json",
        recordText,
        summaryText,
        metadata.referenceMetadata,
        metadata.assignments,
        metadata.selection,
      );
      await Promise.all([
        writeFile(join(directory, "record.jsonl"), recordText),
        writeFile(join(directory, "summary.json"), summaryText),
        writeFile(
          join(directory, "profile-reference.json"),
          serializeProfileReference(metadata.reference),
        ),
        writeFile(
          join(directory, "manifest.jsonl"),
          `${JSON.stringify(entry)}\n`,
        ),
      ]);
      const loaded = await loadCorpusManifest(
        join(directory, "manifest.jsonl"),
      );
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.metadata.id, source.metadata.id);
      assert.equal(evaluateEligibility(summary).eligible, true);
      assert.equal(entry.policyVersion, "championship-eligibility-v3");

      const invalidEntry = {
        ...entry,
        profileAssignments: entry.profileAssignments.map((assignment, index) =>
          index === 0
            ? {
              ...assignment,
              percentileScores: {
                ...assignment.percentileScores,
                aggression: 2,
              },
            }
            : assignment
        ),
      };
      await writeFile(
        join(directory, "manifest.jsonl"),
        `${JSON.stringify(invalidEntry)}\n`,
      );
      await assert.rejects(
        loadCorpusManifest(join(directory, "manifest.jsonl")),
        /Invalid corpus manifest entry/u,
      );

      await writeFile(
        join(directory, "manifest.jsonl"),
        `${JSON.stringify(entry)}\n`,
      );
      await writeFile(join(directory, "record.jsonl"), `${recordText}\n`);
      await assert.rejects(
        loadCorpusManifest(join(directory, "manifest.jsonl")),
        /digest mismatch/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads selected schema-three entries with immutable PUCT targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snake-corpus-search-"));
    try {
      const source = replay();
      const recordText = serializeOfficialReplay(source);
      const summary = buildReplayCorpus(source, { source: "gym" }).summary;
      const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
      const metadata = manifestMetadata(summary);
      const searchText = `${JSON.stringify({
        targetVersion: PUCT_POLICY_TARGET_VERSION,
        telemetryEventId: "event-1",
        recordedAt: "2026-09-17T02:00:00.000Z",
        gameId: source.metadata.id,
        turn: source.states[0]!.turn,
        snakeId: source.states[0]!.you.id,
        snakeName: source.states[0]!.you.name,
        stateKey: canonicalStateKey(source.states[0]!),
        modelVersion: "heuristic-puct-v1",
        selectedMove: "up",
        fallbackMove: "up",
        outcome: 1,
        usedSearch: true,
        fallbackProtected: false,
        rootSafetyOverridden: false,
        deadlineReached: false,
        iterations: 1,
        priorVisits: 0,
        reusedTree: false,
        workersRequested: 1,
        workersCompleted: 1,
        totalVisits: 1,
        policyEligible: true,
        exclusionReasons: [],
        actions: [{
          move: "up",
          visits: 1,
          probability: 1,
          meanValue: 0.5,
          outcomeCount: 1,
          prior: 1,
        }],
      })}\n`;
      const entry = manifestEntry(
          summary,
          "record.jsonl",
          "summary.json",
          recordText,
          summaryText,
          metadata.referenceMetadata,
          metadata.assignments,
          { ...metadata.selection, samplingWeight: 2.5 },
          { path: "search-observations.jsonl", text: searchText },
        );
      await Promise.all([
        writeFile(join(directory, "record.jsonl"), recordText),
        writeFile(join(directory, "summary.json"), summaryText),
        writeFile(
          join(directory, "profile-reference.json"),
          serializeProfileReference(metadata.reference),
        ),
        writeFile(join(directory, "search-observations.jsonl"), searchText),
        writeFile(
          join(directory, "manifest.jsonl"),
          `${JSON.stringify(entry)}\n`,
        ),
      ]);

      const [loaded] = await loadTrainingCorpusManifest(
        join(directory, "manifest.jsonl"),
      );
      assert.equal(entry.schemaVersion, 3);
      assert.equal(loaded?.samplingWeight, 2.5);
      assert.equal(loaded?.searchTargets.length, 1);
      assert.equal(loaded?.searchTargets[0]?.policyEligible, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
