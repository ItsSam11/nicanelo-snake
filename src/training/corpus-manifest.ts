import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BEHAVIOR_PROFILE_NAMES,
  type BehaviorProfileName,
} from "./behavior-profile.js";
import {
  CORPUS_SELECTOR_VERSION,
  type CorpusSelectionMetrics,
  type ProfileAssignment,
} from "./corpus-selection.js";
import {
  parseOfficialReplayJsonl,
  parseReplaySummary,
  supportedInitialSnakeCount,
  validateChampionshipReplay,
  type GameArtifactSource,
  type OfficialReplay,
  type ReplaySummary,
} from "./replay-corpus.js";
import {
  parsePuctPolicyTargetsJsonl,
  type PuctPolicyTarget,
  validatePuctPolicyTargetsForReplay,
} from "./search-targets.js";
import { parseProfileReference } from "./profile-reference.js";

export const CORPUS_MANIFEST_SCHEMA_VERSION = 3 as const;
export const ELIGIBILITY_POLICY_VERSION = "championship-eligibility-v3" as const;

export interface EligibilityDecision {
  eligible: boolean;
  policyVersion: typeof ELIGIBILITY_POLICY_VERSION;
  rejectionReasons: readonly string[];
}

export interface CorpusManifestEntry {
  schemaVersion: typeof CORPUS_MANIFEST_SCHEMA_VERSION;
  policyVersion: typeof ELIGIBILITY_POLICY_VERSION;
  selectorVersion: typeof CORPUS_SELECTOR_VERSION;
  profileReferenceVersion: string;
  profileReferencePath: string;
  profileReferenceDigest: string;
  gameId: string;
  source: GameArtifactSource;
  recordPath: string;
  summaryPath: string;
  recordDigest: string;
  summaryDigest: string;
  profileCoverage: readonly BehaviorProfileName[];
  profileAssignments: readonly ProfileAssignment[];
  selection: CorpusSelectionMetrics;
  searchObservationsPath?: string;
  searchObservationsDigest?: string;
}

export interface LoadedTrainingGame {
  replay: OfficialReplay;
  summary: ReplaySummary;
  samplingWeight: number;
  searchTargets: readonly PuctPolicyTarget[];
}

export interface SearchObservationArtifact {
  path: string;
  text: string;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function evaluateEligibility(
  summary: Readonly<ReplaySummary>,
): EligibilityDecision {
  const reasons: string[] = [];
  if (summary.ruleset !== "standard") reasons.push("ruleset-not-standard");
  if (summary.map !== "standard") reasons.push("map-not-standard");
  if (summary.width !== 11 || summary.height !== 11) {
    reasons.push("board-not-11x11");
  }
  if (!supportedInitialSnakeCount(summary.initialSnakeCount)) {
    reasons.push("initial-snake-count-out-of-range");
  }
  if (summary.observedMoveCount < 1) reasons.push("no-observed-moves");
  if (summary.finalTurn < summary.coverage.firstTurn) {
    reasons.push("invalid-turn-range");
  }
  if (summary.profiles.length !== summary.initialSnakeCount) {
    reasons.push("missing-behavior-profiles");
  }
  if (summary.gameId.trim().length === 0) reasons.push("missing-game-id");
  return {
    eligible: reasons.length === 0,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    rejectionReasons: reasons,
  };
}

export function manifestEntry(
  summary: Readonly<ReplaySummary>,
  recordPath: string,
  summaryPath: string,
  recordText: string,
  summaryText: string,
  profileReference: Readonly<{ version: string; path: string; digest: string }>,
  profileAssignments: readonly ProfileAssignment[],
  selection: Readonly<CorpusSelectionMetrics>,
  searchObservations?: Readonly<SearchObservationArtifact>,
): CorpusManifestEntry {
  const decision = evaluateEligibility(summary);
  if (!decision.eligible) {
    throw new Error(
      `Game ${summary.gameId} is not eligible: ${decision.rejectionReasons.join(", ")}`,
    );
  }
  if (profileReference.version.trim().length === 0) {
    throw new Error("Profile reference version must be non-empty");
  }
  return {
    schemaVersion: CORPUS_MANIFEST_SCHEMA_VERSION,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    selectorVersion: CORPUS_SELECTOR_VERSION,
    profileReferenceVersion: profileReference.version,
    profileReferencePath: profileReference.path,
    profileReferenceDigest: profileReference.digest,
    gameId: summary.gameId,
    source: summary.source,
    recordPath,
    summaryPath,
    recordDigest: sha256(recordText),
    summaryDigest: sha256(summaryText),
    profileCoverage: [...new Set(
      profileAssignments.map((assignment) => assignment.dominantProfile),
    )].sort(),
    profileAssignments: profileAssignments.map((assignment) => ({
      ...assignment,
      rawScores: { ...assignment.rawScores },
      percentileScores: { ...assignment.percentileScores },
    })),
    selection: {
      ...selection,
      coverageTags: [...selection.coverageTags],
      exclusionReasons: [...selection.exclusionReasons],
    },
    ...(searchObservations === undefined
      ? {}
      : {
        searchObservationsPath: searchObservations.path,
        searchObservationsDigest: sha256(searchObservations.text),
      }),
  };
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1;
}

function validScores(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const scores = value as ProfileAssignment["rawScores"];
  return [
    scores.aggression,
    scores.resourceAcquisition,
    scores.healthManagement,
    scores.conservatism,
  ].every(finiteUnit);
}

function validSelection(value: unknown): value is CorpusSelectionMetrics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const selection = value as Partial<CorpusSelectionMetrics>;
  return selection.selectorVersion === CORPUS_SELECTOR_VERSION &&
    typeof selection.selected === "boolean" &&
    [selection.quality, selection.coverage, selection.diversity,
      selection.decisionDensity, selection.selectionScore].every(finiteUnit) &&
    typeof selection.samplingWeight === "number" &&
    Number.isFinite(selection.samplingWeight) && selection.samplingWeight > 0 &&
    Array.isArray(selection.coverageTags) &&
    selection.coverageTags.every((item) => typeof item === "string") &&
    Array.isArray(selection.exclusionReasons) &&
    selection.exclusionReasons.every((item) => typeof item === "string");
}

export function parseManifestLine(value: unknown): CorpusManifestEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Corpus manifest entry must be an object");
  }
  const entry = value as Partial<CorpusManifestEntry>;
  const profileNames = new Set<string>(BEHAVIOR_PROFILE_NAMES);
  const validProfileCoverage = Array.isArray(entry.profileCoverage) &&
    entry.profileCoverage.every((name) =>
      typeof name === "string" && profileNames.has(name)
    );
  const validProfileAssignments = Array.isArray(entry.profileAssignments) &&
    entry.profileAssignments.every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return false;
      }
      const assignment = item as Partial<ProfileAssignment>;
      return typeof assignment.snakeId === "string" &&
        assignment.snakeId.length > 0 &&
        typeof assignment.snakeName === "string" &&
        typeof assignment.dominantProfile === "string" &&
        profileNames.has(assignment.dominantProfile) &&
        validScores(assignment.rawScores) &&
        validScores(assignment.percentileScores) &&
        finiteUnit(assignment.confidence);
    });
  if (
    entry.schemaVersion !== CORPUS_MANIFEST_SCHEMA_VERSION ||
    entry.policyVersion !== ELIGIBILITY_POLICY_VERSION ||
    entry.selectorVersion !== CORPUS_SELECTOR_VERSION ||
    typeof entry.profileReferenceVersion !== "string" ||
    entry.profileReferenceVersion.length === 0 ||
    typeof entry.profileReferencePath !== "string" ||
    entry.profileReferencePath.length === 0 ||
    !sha256Digest(entry.profileReferenceDigest) ||
    typeof entry.gameId !== "string" || entry.gameId.length === 0 ||
    (entry.source !== "live" && entry.source !== "gym") ||
    typeof entry.recordPath !== "string" || entry.recordPath.length === 0 ||
    typeof entry.summaryPath !== "string" || entry.summaryPath.length === 0 ||
    !sha256Digest(entry.recordDigest) || !sha256Digest(entry.summaryDigest) ||
    !validProfileCoverage || !validProfileAssignments ||
    !validSelection(entry.selection)
  ) {
    throw new Error("Invalid corpus manifest entry");
  }
  const hasSearchPath = entry.searchObservationsPath !== undefined;
  const hasSearchDigest = entry.searchObservationsDigest !== undefined;
  if (hasSearchPath !== hasSearchDigest) {
    throw new Error("Incomplete corpus search observation reference");
  }
  if (
    hasSearchPath &&
    (typeof entry.searchObservationsPath !== "string" ||
      entry.searchObservationsPath.length === 0 ||
      !sha256Digest(entry.searchObservationsDigest))
  ) {
    throw new Error("Invalid corpus search observation reference");
  }
  return entry as CorpusManifestEntry;
}

export async function loadTrainingCorpusEntries(
  manifestPath: string,
): Promise<CorpusManifestEntry[]> {
  const text = await readFile(manifestPath, "utf8");
  const entries = text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseManifestLine(JSON.parse(line) as unknown));
  if (entries.length === 0) throw new Error("Corpus manifest is empty");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.selection.selected) {
      throw new Error(`Corpus contains unselected game ${entry.gameId}`);
    }
    if (ids.has(entry.gameId)) {
      throw new Error(`Duplicate game id ${entry.gameId} in corpus manifest`);
    }
    ids.add(entry.gameId);
  }
  return entries;
}

export async function loadTrainingGameFromManifestEntry(
  manifestPath: string,
  entry: Readonly<CorpusManifestEntry>,
  verifiedReferences = new Set<string>(),
): Promise<LoadedTrainingGame> {
  const base = dirname(manifestPath);
  const referenceIdentity =
    `${entry.profileReferencePath}|${entry.profileReferenceDigest}`;
  if (!verifiedReferences.has(referenceIdentity)) {
    const referenceText = await readFile(
      resolve(base, entry.profileReferencePath),
      "utf8",
    );
    if (sha256(referenceText) !== entry.profileReferenceDigest) {
      throw new Error(
        `Profile reference digest mismatch for ${entry.profileReferenceVersion}`,
      );
    }
    const reference = parseProfileReference(
      JSON.parse(referenceText) as unknown,
    );
    if (reference.referenceVersion !== entry.profileReferenceVersion) {
      throw new Error(
        `Profile reference identity mismatch for ${entry.profileReferenceVersion}`,
      );
    }
    verifiedReferences.add(referenceIdentity);
  }
  const recordText = await readFile(resolve(base, entry.recordPath), "utf8");
  const summaryText = await readFile(resolve(base, entry.summaryPath), "utf8");
  if (sha256(recordText) !== entry.recordDigest) {
    throw new Error(`Record digest mismatch for game ${entry.gameId}`);
  }
  if (sha256(summaryText) !== entry.summaryDigest) {
    throw new Error(`Summary digest mismatch for game ${entry.gameId}`);
  }
  const replay = parseOfficialReplayJsonl(recordText);
  const summary = parseReplaySummary(summaryText);
  validateChampionshipReplay(replay);
  if (
    replay.metadata.id !== entry.gameId || summary.gameId !== entry.gameId ||
    summary.source !== entry.source
  ) {
    throw new Error(`Manifest identity mismatch for game ${entry.gameId}`);
  }
  let searchTargets: PuctPolicyTarget[] = [];
  if (
    entry.searchObservationsPath !== undefined &&
    entry.searchObservationsDigest !== undefined
  ) {
    const searchText = await readFile(
      resolve(base, entry.searchObservationsPath),
      "utf8",
    );
    if (sha256(searchText) !== entry.searchObservationsDigest) {
      throw new Error(
        `Search observations digest mismatch for game ${entry.gameId}`,
      );
    }
    searchTargets = parsePuctPolicyTargetsJsonl(searchText);
    validatePuctPolicyTargetsForReplay(searchTargets, replay);
  }
  return {
    replay,
    summary,
    samplingWeight: entry.selection.samplingWeight,
    searchTargets,
  };
}

export async function* iterateTrainingCorpusManifest(
  manifestPath: string,
  entries?: readonly CorpusManifestEntry[],
): AsyncGenerator<LoadedTrainingGame> {
  const selected = entries ?? await loadTrainingCorpusEntries(manifestPath);
  const verifiedReferences = new Set<string>();
  for (const entry of selected) {
    yield await loadTrainingGameFromManifestEntry(
      manifestPath,
      entry,
      verifiedReferences,
    );
  }
}

export async function loadTrainingCorpusManifest(
  manifestPath: string,
): Promise<LoadedTrainingGame[]> {
  const games: LoadedTrainingGame[] = [];
  for await (const game of iterateTrainingCorpusManifest(manifestPath)) {
    games.push(game);
  }
  return games;
}

export async function loadCorpusManifest(
  manifestPath: string,
): Promise<OfficialReplay[]> {
  return (await loadTrainingCorpusManifest(manifestPath)).map(
    (game) => game.replay,
  );
}
