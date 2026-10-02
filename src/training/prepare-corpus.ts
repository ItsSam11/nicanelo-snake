import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { BehaviorScores } from "../model/behavior-features.js";
import {
  evaluateEligibility,
  manifestEntry,
  type CorpusManifestEntry,
} from "./corpus-manifest.js";
import {
  BEHAVIOR_PROFILE_NAMES,
  type BehaviorProfileName,
} from "./behavior-profile.js";
import {
  selectCorpusGames,
  type CorpusSelectionOptions,
  type ProfileAssignment,
} from "./corpus-selection.js";
import {
  parseProfileReference,
  profilePercentiles,
  profileReferenceDigest,
} from "./profile-reference.js";
import {
  parseOfficialReplayJsonl,
  parseReplaySummary,
  validateChampionshipReplay,
  type ReplaySummary,
} from "./replay-corpus.js";
import {
  parsePuctPolicyTargetsJsonl,
  validatePuctPolicyTargetsForReplay,
} from "./search-targets.js";

async function filesRecursively(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : [child];
  }));
  return nested.flat();
}

function jsonLines(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

export interface PrepareCorpusResult {
  eligible: number;
  selected: number;
  rejected: number;
  eligibleManifest: string;
  corpusManifest: string;
}

interface AcceptedGame {
  summary: ReplaySummary;
  recordPath: string;
  summaryPath: string;
  recordText: string;
  summaryText: string;
  searchObservationsPath?: string;
  searchObservationsText?: string;
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assignmentName(scores: Readonly<BehaviorScores>): BehaviorProfileName {
  const candidates: readonly [BehaviorProfileName, number][] = [
    ["aggression", scores.aggression],
    ["resource-acquisition", scores.resourceAcquisition],
    ["health-management", scores.healthManagement],
    ["conservatism", scores.conservatism],
  ];
  return candidates.reduce((best, candidate) =>
    candidate[1] > best[1] ? candidate : best
  )[0];
}

export async function prepareCorpus(
  telemetryRoot: string,
  selectionId: string,
  corpusId: string,
  profileReferenceVersion: string,
  selectionOptions: Readonly<CorpusSelectionOptions> = {},
): Promise<PrepareCorpusResult> {
  const rawRoot = join(telemetryRoot, "raw");
  const summaries = (await filesRecursively(rawRoot))
    .filter((path) => path.endsWith("/summary.json"))
    .sort();
  const eligibleDirectory = join(telemetryRoot, "eligible", selectionId);
  const corpusDirectory = join(telemetryRoot, "corpus", corpusId);
  const eligibleManifest = join(eligibleDirectory, "manifest.jsonl");
  const corpusManifest = join(corpusDirectory, "manifest.jsonl");
  const referencePath = join(
    telemetryRoot,
    "references",
    `${profileReferenceVersion}.json`,
  );
  const reference = parseProfileReference(
    JSON.parse(await readFile(referencePath, "utf8")) as unknown,
  );
  if (reference.referenceVersion !== profileReferenceVersion) {
    throw new Error("Profile reference version does not match its path");
  }
  const referenceDigest = profileReferenceDigest(reference);
  const accepted: AcceptedGame[] = [];
  const rejected: unknown[] = [];
  const acceptedGameIds = new Set<string>();

  for (const summaryPath of summaries) {
    const recordPath = join(dirname(summaryPath), "record.jsonl");
    const searchObservationsPath = join(
      dirname(summaryPath),
      "search-observations.jsonl",
    );
    let recordText: string;
    let summaryText: string;
    let searchObservationsText: string | undefined;
    try {
      [recordText, summaryText, searchObservationsText] = await Promise.all([
        readFile(recordPath, "utf8"),
        readFile(summaryPath, "utf8"),
        optionalFile(searchObservationsPath),
      ]);
    } catch {
      rejected.push({ summaryPath, rejectionReasons: ["missing-record"] });
      continue;
    }
    let summary: ReplaySummary;
    try {
      summary = parseReplaySummary(summaryText);
    } catch {
      rejected.push({ summaryPath, rejectionReasons: ["invalid-summary"] });
      continue;
    }
    try {
      const replay = parseOfficialReplayJsonl(recordText);
      validateChampionshipReplay(replay);
      const initial = replay.states[0];
      if (
        replay.metadata.id !== summary.gameId ||
        replay.metadata.ruleset.name !== summary.ruleset ||
        replay.metadata.map !== summary.map ||
        initial === undefined ||
        initial.board.width !== summary.width ||
        initial.board.height !== summary.height ||
        initial.board.snakes.length !== summary.initialSnakeCount ||
        replay.result.winnerId !== summary.winnerId ||
        replay.result.isDraw !== summary.isDraw
      ) {
        throw new Error("Record and summary disagree");
      }
      if (searchObservationsText !== undefined) {
        const targets = parsePuctPolicyTargetsJsonl(searchObservationsText);
        if (targets.length === 0) {
          throw new Error("Search observations and summary disagree");
        }
        validatePuctPolicyTargetsForReplay(targets, replay);
      }
    } catch {
      rejected.push({
        gameId: summary.gameId,
        summaryPath,
        rejectionReasons: ["invalid-or-mismatched-record"],
      });
      continue;
    }
    const decision = evaluateEligibility(summary);
    if (!decision.eligible) {
      rejected.push({
        gameId: summary.gameId,
        summaryPath,
        rejectionReasons: decision.rejectionReasons,
      });
      continue;
    }
    if (acceptedGameIds.has(summary.gameId)) {
      rejected.push({
        gameId: summary.gameId,
        summaryPath,
        rejectionReasons: ["duplicate-game-id"],
      });
      continue;
    }
    acceptedGameIds.add(summary.gameId);
    accepted.push({
      summary,
      recordPath,
      summaryPath,
      recordText,
      summaryText,
      ...(searchObservationsText === undefined
        ? {}
        : { searchObservationsPath, searchObservationsText }),
    });
  }

  const assignments = new Map<string, ProfileAssignment[]>();
  for (const item of accepted) {
    assignments.set(item.summary.gameId, item.summary.profiles.map((profile) => {
      const percentileScores = profilePercentiles(profile.scores, reference);
      return {
        snakeId: profile.snakeId,
        snakeName: profile.snakeName,
        dominantProfile: assignmentName(percentileScores),
        rawScores: { ...profile.scores },
        percentileScores,
        confidence: profile.confidence.overall,
      };
    }));
  }
  const selections = new Map(selectCorpusGames(
    accepted.map((item) => ({
      summary: item.summary,
      profileAssignments: assignments.get(item.summary.gameId) ?? [],
    })),
    selectionOptions,
  ).map((item) => [item.gameId, item.metrics]));

  function entriesFor(
    manifestPath: string,
    selectedOnly: boolean,
  ): CorpusManifestEntry[] {
    const base = dirname(manifestPath);
    return accepted.flatMap((item) => {
      const selection = selections.get(item.summary.gameId);
      const profileAssignments = assignments.get(item.summary.gameId);
      if (selection === undefined || profileAssignments === undefined) {
        throw new Error(`Missing selection for ${item.summary.gameId}`);
      }
      if (selectedOnly && !selection.selected) return [];
      return [manifestEntry(
        item.summary,
        relative(base, item.recordPath),
        relative(base, item.summaryPath),
        item.recordText,
        item.summaryText,
        {
          version: reference.referenceVersion,
          digest: referenceDigest,
          path: relative(base, referencePath),
        },
        profileAssignments,
        selection,
        item.searchObservationsPath === undefined ||
            item.searchObservationsText === undefined
          ? undefined
          : {
            path: relative(base, item.searchObservationsPath),
            text: item.searchObservationsText,
          },
      )];
    });
  }

  await Promise.all([
    mkdir(eligibleDirectory, { recursive: true }),
    mkdir(corpusDirectory, { recursive: true }),
  ]);
  const eligibleEntries = entriesFor(eligibleManifest, false);
  const corpusEntries = entriesFor(corpusManifest, true);
  await Promise.all([
    writeFile(eligibleManifest, jsonLines(eligibleEntries), { flag: "wx" }),
    writeFile(
      join(eligibleDirectory, "rejected.jsonl"),
      jsonLines(rejected),
      { flag: "wx" },
    ),
    writeFile(corpusManifest, jsonLines(corpusEntries), { flag: "wx" }),
    writeFile(
      join(eligibleDirectory, "selection.json"),
      `${JSON.stringify({
        selectionId,
        corpusId,
        selectorVersion: eligibleEntries[0]?.selectorVersion ?? null,
        profileReferenceVersion: reference.referenceVersion,
        profileReferenceDigest: referenceDigest,
        eligibleGames: accepted.length,
        selectedGames: corpusEntries.length,
        rejectedGames: rejected.length,
        excludedBySelector: eligibleEntries
          .filter((entry) => !entry.selection.selected)
          .map((entry) => ({
            gameId: entry.gameId,
            reasons: entry.selection.exclusionReasons,
          })),
        profileDistribution: Object.fromEntries(
          BEHAVIOR_PROFILE_NAMES.map((name) => [
            name,
            corpusEntries.flatMap((entry) => entry.profileAssignments)
              .filter((assignment) => assignment.dominantProfile === name).length,
          ]),
        ),
      }, null, 2)}\n`,
      { flag: "wx" },
    ),
  ]);
  return {
    eligible: accepted.length,
    selected: corpusEntries.length,
    rejected: rejected.length,
    eligibleManifest,
    corpusManifest,
  };
}

function parseOptionalMaximumGames(args: readonly string[]): number | undefined {
  const index = args.indexOf("--max-games");
  if (index < 0) return undefined;
  const value = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("--max-games must be a positive integer");
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [telemetryRoot, selectionId, corpusId, profileReferenceVersion] = args;
  if (
    telemetryRoot === undefined || selectionId === undefined ||
    corpusId === undefined || profileReferenceVersion === undefined
  ) {
    throw new Error(
      "Usage: prepare-corpus <telemetry-root> <selection-id> <corpus-id> <profile-reference-version> [--max-games N]",
    );
  }
  const maximumGames = parseOptionalMaximumGames(args.slice(4));
  console.log(JSON.stringify(await prepareCorpus(
    telemetryRoot,
    selectionId,
    corpusId,
    profileReferenceVersion,
    maximumGames === undefined ? {} : { maximumGames },
  )));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
