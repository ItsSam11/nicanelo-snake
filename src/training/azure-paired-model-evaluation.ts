import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { parseReplaySummary, type ReplaySummary } from "./replay-corpus.js";
import {
  evaluatePairedModels,
  type CohortSummary,
} from "./paired-model-evaluation.js";

interface Options {
  accountUrl: string;
  containerName: string;
  baselinePrefix: string;
  candidatePrefix: string;
  repairPrefix?: string;
  repairShards: ReadonlySet<number>;
  splitRepairPrefix?: string;
  splitRepairShard?: number;
  splitRepairParts?: number;
  incompleteSplitParts: ReadonlySet<number>;
  expectedExcludedGames: number;
  jobsPerCohort: number;
  lanesPerJob: number;
  gamesPerCohort: number;
  subjectName: string;
  candidateModelVersion: string;
  strictProvenance: boolean;
  outputPath?: string;
}

interface ManifestEntry {
  success: boolean;
  seed: number;
  lane: number;
  snakeOrder?: readonly string[];
  recordFile?: string;
  summaryFile?: string;
  observationsFile?: string;
  summary?: ReplaySummary;
  error?: string;
}

export interface ShardMarker {
  games: number;
  lanes: number;
  uniqueSeeds: number;
  uniqueGameIds: number;
  roster: readonly string[];
  subjectModelVersion: string;
  provenance: Readonly<Record<string, unknown>>;
  baseSeed: number;
  gameIndexOffset: number;
}

interface LoadedShard {
  cohort: string;
  number: number;
  kind: "shard" | "split-part";
  prefix: string;
  repaired: boolean;
  marker: ShardMarker | null;
  exclusions: readonly CandidateExclusion[];
  summaries: readonly CohortSummary[];
}

interface CandidateExclusion {
  cohort: string;
  prefix: string;
  lane: number;
  seed: number;
  reason: string;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function booleanValue(value: string, flag: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${flag} must be true or false`);
}

function parseIntegerSet(value: string, flag: string): Set<number> {
  if (value.trim().length === 0) return new Set();
  return new Set(value.split(",").map((part) =>
    positiveInteger(part.trim(), flag)
  ));
}

export function parseOptions(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Options {
  const values: Partial<Omit<Options, "repairShards">> = {
    containerName: "battlesnake-corpus",
    jobsPerCohort: 30,
    lanesPerJob: 5,
    gamesPerCohort: 3000,
    subjectName: "Nicanelo",
    strictProvenance: true,
  };
  const accountUrl = environment.AZURE_STORAGE_ACCOUNT_URL?.trim();
  if (accountUrl) values.accountUrl = accountUrl;
  let repairShards = new Set<number>();
  let incompleteSplitParts = new Set<number>();
  let expectedExcludedGames = 0;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    switch (flag) {
      case "--account-url": values.accountUrl = value; break;
      case "--container": values.containerName = value; break;
      case "--baseline-prefix": values.baselinePrefix = value; break;
      case "--candidate-prefix": values.candidatePrefix = value; break;
      case "--repair-prefix": values.repairPrefix = value; break;
      case "--repair-shards":
        repairShards = parseIntegerSet(value, flag);
        break;
      case "--split-repair-prefix": values.splitRepairPrefix = value; break;
      case "--split-repair-shard":
        values.splitRepairShard = positiveInteger(value, flag);
        break;
      case "--split-repair-parts":
        values.splitRepairParts = positiveInteger(value, flag);
        break;
      case "--incomplete-split-parts":
        incompleteSplitParts = parseIntegerSet(value, flag);
        break;
      case "--expected-excluded-games":
        expectedExcludedGames = nonNegativeInteger(value, flag);
        break;
      case "--jobs-per-cohort":
        values.jobsPerCohort = positiveInteger(value, flag);
        break;
      case "--lanes-per-job":
        values.lanesPerJob = positiveInteger(value, flag);
        break;
      case "--games-per-cohort":
        values.gamesPerCohort = positiveInteger(value, flag);
        break;
      case "--subject-name": values.subjectName = value; break;
      case "--candidate-model-version":
        values.candidateModelVersion = value;
        break;
      case "--strict-provenance":
        values.strictProvenance = booleanValue(value, flag);
        break;
      case "--output": values.outputPath = value; break;
      default: throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (!values.accountUrl?.trim()) {
    throw new Error(
      "--account-url or AZURE_STORAGE_ACCOUNT_URL is required",
    );
  }
  for (const required of [
    "baselinePrefix",
    "candidatePrefix",
    "candidateModelVersion",
  ] as const) {
    if (values[required] === undefined) throw new Error(`--${required.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (repairShards.size > 0 && values.repairPrefix === undefined) {
    throw new Error("--repair-prefix is required when --repair-shards is set");
  }
  const splitValues = [
    values.splitRepairPrefix,
    values.splitRepairShard,
    values.splitRepairParts,
  ];
  if (splitValues.some((value) => value !== undefined) &&
      splitValues.some((value) => value === undefined)) {
    throw new Error(
      "--split-repair-prefix, --split-repair-shard, and " +
      "--split-repair-parts must be set together",
    );
  }
  if (incompleteSplitParts.size > 0 && values.splitRepairPrefix === undefined) {
    throw new Error(
      "--incomplete-split-parts requires split repair options",
    );
  }
  return {
    ...values,
    repairShards,
    incompleteSplitParts,
    expectedExcludedGames,
  } as Options;
}

async function downloadText(
  container: ContainerClient,
  blobName: string,
): Promise<string> {
  try {
    return (await container.getBlockBlobClient(blobName).downloadToBuffer())
      .toString("utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown Blob error";
    throw new Error(`Could not download ${blobName}: ${detail}`);
  }
}

function parseManifest(
  text: string,
  blobName: string,
  lane: number,
): ManifestEntry[] {
  return text.split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${blobName}:${index + 1} is not valid JSON`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${blobName}:${index + 1} is not a manifest object`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.success !== "boolean" || !Number.isSafeInteger(entry.seed)) {
        throw new Error(`${blobName}:${index + 1} has invalid status or seed`);
      }
      const summary = entry.summary === undefined
        ? undefined
        : parseReplaySummary(JSON.stringify(entry.summary));
      return {
        success: entry.success,
        seed: entry.seed as number,
        lane,
        ...(Array.isArray(entry.snakeOrder) &&
            entry.snakeOrder.every((item) => typeof item === "string")
          ? { snakeOrder: entry.snakeOrder as string[] }
          : {}),
        ...(typeof entry.recordFile === "string"
          ? { recordFile: entry.recordFile }
          : {}),
        ...(typeof entry.summaryFile === "string"
          ? { summaryFile: entry.summaryFile }
          : {}),
        ...(typeof entry.observationsFile === "string"
          ? { observationsFile: entry.observationsFile }
          : {}),
        ...(summary === undefined ? {} : { summary }),
        ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      };
    });
}

export function parseShardMarker(text: string, blobName: string): ShardMarker {
  const value = JSON.parse(text) as Partial<ShardMarker>;
  if (
    ![value.games, value.lanes, value.uniqueSeeds, value.uniqueGameIds,
      value.baseSeed, value.gameIndexOffset].every(Number.isSafeInteger) ||
    (value.games ?? 0) < 1 || (value.lanes ?? 0) < 1 ||
    (value.uniqueSeeds ?? -1) < 0 || (value.uniqueGameIds ?? -1) < 0 ||
    (value.baseSeed ?? -1) < 0 || (value.gameIndexOffset ?? -1) < 0 ||
    typeof value.subjectModelVersion !== "string" ||
    value.subjectModelVersion.length === 0 ||
    !Array.isArray(value.roster) ||
    value.roster.length < 2 ||
    !value.roster.every((item) => typeof item === "string") ||
    typeof value.provenance !== "object" || value.provenance === null ||
    Array.isArray(value.provenance)
  ) {
    throw new Error(`${blobName} is not a valid shard marker`);
  }
  return value as ShardMarker;
}

function assertValidCausalProvenance(
  marker: Readonly<ShardMarker>,
  label: string,
): void {
  for (const field of ["jobImageDigest", "subjectModelSha256"] as const) {
    const value = provenanceField(marker, field, label);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label} provenance has invalid ${field}`);
    }
  }
  for (const field of [
    "searchTimeBudgetMs",
    "searchResponseReserveMs",
  ] as const) {
    const value = provenanceField(marker, field, label);
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`${label} provenance has invalid ${field}`);
    }
  }
  const zoo = provenanceField(marker, "zoo", label);
  if (typeof zoo !== "object" || zoo === null || Array.isArray(zoo)) {
    throw new Error(`${label} provenance has invalid zoo`);
  }
}

function provenanceField(
  marker: Readonly<ShardMarker>,
  field: string,
  label: string,
): unknown {
  const value = marker.provenance[field];
  if (value === undefined) {
    throw new Error(`${label} provenance is missing ${field}`);
  }
  return value;
}

function requirePairedValue(
  baseline: unknown,
  candidate: unknown,
  field: string,
  context: string,
): void {
  if (!isDeepStrictEqual(baseline, candidate)) {
    throw new Error(`Paired provenance differs for ${context}: ${field}`);
  }
}

/**
 * Fails closed unless the two shards differ only in the two intended root
 * safety switches. Campaign/run identifiers and compute-pool placement are
 * deliberately excluded because they are operational, not causal inputs.
 */
export function assertPairedShardProvenance(
  baseline: Readonly<ShardMarker>,
  candidate: Readonly<ShardMarker>,
  context: string,
): void {
  assertValidCausalProvenance(baseline, "baseline");
  assertValidCausalProvenance(candidate, "candidate");
  for (const field of [
    "games",
    "lanes",
    "uniqueSeeds",
    "baseSeed",
    "gameIndexOffset",
    "roster",
    "subjectModelVersion",
  ] as const) {
    requirePairedValue(baseline[field], candidate[field], field, context);
  }
  if (
    baseline.uniqueSeeds !== baseline.games ||
    candidate.uniqueSeeds !== candidate.games ||
    baseline.uniqueGameIds !== baseline.games ||
    candidate.uniqueGameIds !== candidate.games
  ) {
    throw new Error(`Paired provenance has non-unique games for ${context}`);
  }

  for (const field of [
    "jobImageDigest",
    "subjectModelSha256",
    "searchTimeBudgetMs",
    "searchResponseReserveMs",
    "zoo",
  ] as const) {
    requirePairedValue(
      provenanceField(baseline, field, "baseline"),
      provenanceField(candidate, field, "candidate"),
      field,
      context,
    );
  }
  for (const field of ["cohort", "engineVersion", "strategicRootPrior"] as const) {
    const baselineValue = baseline.provenance[field];
    const candidateValue = candidate.provenance[field];
    if (baselineValue !== undefined || candidateValue !== undefined) {
      requirePairedValue(baselineValue, candidateValue, field, context);
    }
  }
  for (const [label, marker] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    requirePairedValue(
      marker.subjectModelVersion,
      provenanceField(marker, "subjectModelVersion", label),
      `${label}.subjectModelVersion`,
      context,
    );
  }

  const expectedFlags = [
    ["rootSafetyArbiter", false, true],
    ["rootBranchingReserve", false, true],
  ] as const;
  for (const [field, expectedBaseline, expectedCandidate] of expectedFlags) {
    if (provenanceField(baseline, field, "baseline") !== expectedBaseline) {
      throw new Error(
        `Invalid baseline provenance for ${context}: ${field} must be ${expectedBaseline}`,
      );
    }
    if (provenanceField(candidate, field, "candidate") !== expectedCandidate) {
      throw new Error(
        `Invalid candidate provenance for ${context}: ${field} must be ${expectedCandidate}`,
      );
    }
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item);
    }
  }));
  return results;
}

function manifestEntryProblem(
  entry: Readonly<ManifestEntry>,
  candidateModelVersion: string,
  requireSnakeOrder = false,
): string | undefined {
  if (!entry.success) return `game-failed: ${entry.error ?? "unknown error"}`;
  if (entry.summary === undefined) return "manifest-summary-missing";
  if (
    entry.summary.modelVersions.length !== 1 ||
    entry.summary.modelVersions[0] !== candidateModelVersion
  ) return "candidate-model-version-invalid";
  if (
    entry.summary.coverage.kind !== "full" ||
    entry.summary.coverage.missingTurnCount !== 0
  ) return "telemetry-coverage-incomplete";
  if (requireSnakeOrder) {
    if (
      entry.snakeOrder === undefined ||
      entry.snakeOrder.length !== entry.summary.initialSnakeCount
    ) return "snake-order-missing-or-invalid";
    const profileNames = entry.summary.profiles.map((profile) => profile.snakeName)
      .sort((a, b) => a.localeCompare(b));
    const orderedNames = [...entry.snakeOrder].sort((a, b) => a.localeCompare(b));
    if (!isDeepStrictEqual(profileNames, orderedNames)) {
      return "snake-order-roster-mismatch";
    }
  }
  return undefined;
}

async function missingArtifacts(
  container: ContainerClient,
  prefix: string,
  entry: Readonly<ManifestEntry>,
): Promise<string[]> {
  const files = [
    ["record", entry.recordFile],
    ["summary", entry.summaryFile],
    ["observations", entry.observationsFile],
  ] as const;
  const missingReferences = files.flatMap(([label, name]) =>
    name === undefined ? [`${label}-reference`] : []
  );
  if (missingReferences.length > 0) return missingReferences;
  const lane = `lane-${String(entry.lane).padStart(2, "0")}`;
  const existence = await Promise.all(files.map(async ([label, name]) => ({
    label,
    exists: await container.getBlockBlobClient(
      `${prefix}/${lane}/${name!}`,
    ).exists(),
  })));
  return existence.flatMap((item) => item.exists ? [] : [item.label]);
}

async function loadCandidateGroup(
  container: ContainerClient,
  options: Readonly<Options>,
  plan: Readonly<{
    cohort: string;
    number: number;
    kind: "shard" | "split-part";
    prefix: string;
    repaired: boolean;
    expectedGames: number;
    markerRequired: boolean;
  }>,
): Promise<LoadedShard> {
  const markerName = `${plan.prefix}/summary.json`;
  const [markerText, manifestTexts] = await Promise.all([
    plan.markerRequired ? downloadText(container, markerName) : undefined,
    Promise.all(
      Array.from({ length: options.lanesPerJob }, (_, lane) =>
        downloadText(
          container,
          `${plan.prefix}/lane-${String(lane + 1).padStart(2, "0")}/manifest.jsonl`,
        )
      ),
    ),
  ]);
  const marker = markerText === undefined
    ? null
    : parseShardMarker(markerText, markerName);
  const entries = manifestTexts.flatMap((text, lane) =>
    parseManifest(
      text,
      `${plan.prefix}/lane-${String(lane + 1).padStart(2, "0")}/manifest.jsonl`,
      lane + 1,
    )
  );
  if (entries.length !== plan.expectedGames) {
    throw new Error(
      `Invalid paired group ${plan.prefix}: expected ${plan.expectedGames} ` +
      `manifest entries, found ${entries.length}`,
    );
  }
  const problems = await mapConcurrent(entries, 8, async (entry) => {
    const problem = manifestEntryProblem(
      entry,
      options.candidateModelVersion,
      options.strictProvenance,
    );
    if (problem !== undefined || plan.markerRequired) return problem;
    const missing = await missingArtifacts(container, plan.prefix, entry);
    return missing.length === 0
      ? undefined
      : `missing-artifacts: ${missing.join(",")}`;
  });
  const exclusions = entries.flatMap((entry, index): CandidateExclusion[] => {
    const reason = problems[index];
    return reason === undefined ? [] : [{
      cohort: plan.cohort,
      prefix: plan.prefix,
      lane: entry.lane,
      seed: entry.seed,
      reason,
    }];
  });
  const accepted = entries.filter((_, index) => problems[index] === undefined);
  const seeds = new Set(entries.map((entry) => entry.seed));
  const gameIds = new Set(accepted.flatMap((entry) =>
    entry.summary === undefined ? [] : [entry.summary.gameId]
  ));
  if (marker !== null && (
    exclusions.length > 0 || entries.length !== marker.games ||
    seeds.size !== marker.uniqueSeeds || gameIds.size !== marker.uniqueGameIds ||
    marker.subjectModelVersion !== options.candidateModelVersion
  )) {
    throw new Error(
      `Invalid paired group ${plan.prefix}: entries=${entries.length}, ` +
      `excluded=${exclusions.length}, seeds=${seeds.size}, games=${gameIds.size}`,
    );
  }
  return {
    cohort: plan.cohort,
    number: plan.number,
    kind: plan.kind,
    prefix: plan.prefix,
    repaired: plan.repaired,
    marker,
    exclusions,
    summaries: accepted.map((entry) => ({
      cohort: plan.cohort,
      summary: {
        ...entry.summary!,
        ...(entry.snakeOrder === undefined
          ? {}
          : { snakeOrder: entry.snakeOrder }),
      },
    })),
  };
}

async function loadCandidateShard(
  container: ContainerClient,
  options: Readonly<Options>,
  cohort: string,
  number: number,
): Promise<LoadedShard> {
  const repaired = cohort === "challenger" && options.repairShards.has(number);
  const root = repaired ? options.repairPrefix! : options.candidatePrefix;
  const gamesPerShard = options.gamesPerCohort / options.jobsPerCohort;
  if (!Number.isSafeInteger(gamesPerShard)) {
    throw new Error("games per cohort must divide evenly across jobs");
  }
  return await loadCandidateGroup(container, options, {
    cohort,
    number,
    kind: "shard",
    prefix: `${root}/${cohort}/shard-${number}`,
    repaired,
    expectedGames: gamesPerShard,
    markerRequired: true,
  });
}

async function loadBaselineShard(
  container: ContainerClient,
  options: Readonly<Options>,
  cohort: string,
  number: number,
): Promise<LoadedShard> {
  const gamesPerShard = options.gamesPerCohort / options.jobsPerCohort;
  if (!Number.isSafeInteger(gamesPerShard)) {
    throw new Error("games per cohort must divide evenly across jobs");
  }
  return await loadCandidateGroup(container, options, {
    cohort,
    number,
    kind: "shard",
    prefix: `${options.baselinePrefix}/${cohort}/shard-${number}`,
    repaired: false,
    expectedGames: gamesPerShard,
    markerRequired: true,
  });
}

async function loadBaseline(
  container: ContainerClient,
  options: Readonly<Options>,
): Promise<CohortSummary[]> {
  const manifestNames = ["challenger", "legacy"].flatMap((cohort) =>
    Array.from({ length: options.jobsPerCohort }, (_, job) =>
      Array.from({ length: options.lanesPerJob }, (_, lane) => ({
        cohort,
        lane: lane + 1,
        name: `${options.baselinePrefix}/${cohort}/shard-${job + 1}/lane-${
          String(lane + 1).padStart(2, "0")
        }/manifest.jsonl`,
      }))
    ).flat()
  );
  const manifests = await mapConcurrent(manifestNames, 24, async (item) => ({
    cohort: item.cohort,
    entries: parseManifest(
      await downloadText(container, item.name),
      item.name,
      item.lane,
    ),
  }));
  return manifests.flatMap((manifest) => manifest.entries.flatMap((entry) =>
    entry.success && entry.summary !== undefined
      ? [{
        cohort: manifest.cohort,
        summary: {
          ...entry.summary,
          ...(entry.snakeOrder === undefined
            ? {}
            : { snakeOrder: entry.snakeOrder }),
        },
      }]
      : []
  ));
}

export async function runAzurePairedEvaluation(
  options: Readonly<Options>,
): Promise<Record<string, unknown>> {
  if (options.strictProvenance && options.splitRepairPrefix !== undefined) {
    throw new Error(
      "Strict provenance does not support split repairs; rerun a complete " +
      "paired shard or pass --strict-provenance false for a historical audit",
    );
  }
  const container = new BlobServiceClient(
    options.accountUrl,
    new DefaultAzureCredential(),
  ).getContainerClient(options.containerName);
  const plans = ["challenger", "legacy"].flatMap((cohort) =>
    Array.from({ length: options.jobsPerCohort }, (_, index) => ({
      cohort,
      number: index + 1,
    }))
  ).filter((plan) =>
    !(plan.cohort === "challenger" && plan.number === options.splitRepairShard)
  );
  const standardGroups = await mapConcurrent(plans, 16, (plan) =>
    loadCandidateShard(container, options, plan.cohort, plan.number)
  );
  const baselineGroups = options.strictProvenance
    ? await mapConcurrent(plans, 16, (plan) =>
      loadBaselineShard(container, options, plan.cohort, plan.number)
    )
    : [];
  if (options.strictProvenance) {
    const baselineByPair = new Map(baselineGroups.map((group) => [
      `${group.cohort}|${group.number}`,
      group,
    ]));
    for (const candidateGroup of standardGroups) {
      const key = `${candidateGroup.cohort}|${candidateGroup.number}`;
      const baselineGroup = baselineByPair.get(key);
      if (baselineGroup === undefined) {
        throw new Error(`Baseline is missing provenance group ${key}`);
      }
      if (baselineGroup.marker === null || candidateGroup.marker === null) {
        throw new Error(`Paired provenance marker is missing for ${key}`);
      }
      assertPairedShardProvenance(
        baselineGroup.marker,
        candidateGroup.marker,
        key,
      );
    }
  }
  let splitGroups: LoadedShard[] = [];
  if (
    options.splitRepairPrefix !== undefined &&
    options.splitRepairShard !== undefined &&
    options.splitRepairParts !== undefined
  ) {
    const gamesPerShard = options.gamesPerCohort / options.jobsPerCohort;
    const gamesPerPart = gamesPerShard / options.splitRepairParts;
    if (!Number.isSafeInteger(gamesPerPart)) {
      throw new Error("split repair parts must divide a shard evenly");
    }
    splitGroups = await mapConcurrent(
      Array.from({ length: options.splitRepairParts }, (_, index) => index + 1),
      16,
      (part) => loadCandidateGroup(container, options, {
        cohort: "challenger",
        number: part,
        kind: "split-part",
        prefix: `${options.splitRepairPrefix}/challenger/part-${
          String(part).padStart(2, "0")
        }`,
        repaired: true,
        expectedGames: gamesPerPart,
        markerRequired: !options.incompleteSplitParts.has(part),
      }),
    );
  }
  const candidateGroups = [...standardGroups, ...splitGroups];
  const exclusions = candidateGroups.flatMap((group) => group.exclusions);
  const candidate = candidateGroups.flatMap((group) => group.summaries);
  const candidateSeeds = new Set(candidate.map((entry) =>
    `${entry.cohort}|${entry.summary.seed}`
  ));
  const baselineAll = options.strictProvenance
    ? baselineGroups.flatMap((group) => group.summaries)
    : await loadBaseline(container, options);
  const baseline = baselineAll.filter((entry) =>
    candidateSeeds.has(`${entry.cohort}|${entry.summary.seed}`)
  );
  const cohortCounts = Object.fromEntries(["challenger", "legacy"].map((cohort) => [
    cohort,
    candidate.filter((entry) => entry.cohort === cohort).length,
  ]));
  const expectedGames = options.gamesPerCohort * 2 -
    options.expectedExcludedGames;
  if (
    candidate.length !== expectedGames ||
    candidateSeeds.size !== candidate.length ||
    cohortCounts.challenger !== options.gamesPerCohort -
      options.expectedExcludedGames ||
    cohortCounts.legacy !== options.gamesPerCohort ||
    baseline.length !== candidate.length ||
    exclusions.length !== options.expectedExcludedGames
  ) {
    throw new Error(
      `Coverage mismatch: candidate=${candidate.length}, unique=${candidateSeeds.size}, ` +
      `challenger=${cohortCounts.challenger}, legacy=${cohortCounts.legacy}, ` +
      `baseline=${baseline.length}, excluded=${exclusions.length}`,
    );
  }
  const evaluation = evaluatePairedModels(baseline, candidate, options.subjectName);
  const result = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baselinePrefix: options.baselinePrefix,
    candidatePrefix: options.candidatePrefix,
    repairPrefix: options.repairPrefix ?? null,
    repairedShards: [...options.repairShards].sort((a, b) => a - b),
    splitRepairPrefix: options.splitRepairPrefix ?? null,
    splitRepairShard: options.splitRepairShard ?? null,
    splitRepairParts: options.splitRepairParts ?? null,
    acceptedIncompleteSplitParts: [...options.incompleteSplitParts]
      .sort((a, b) => a - b),
    candidateModelVersion: options.candidateModelVersion,
    integrity: {
      strictProvenance: options.strictProvenance,
      pairedProvenanceGroups: baselineGroups.length,
      groups: candidateGroups.length,
      shards: standardGroups.length,
      splitParts: splitGroups.length,
      repairedGroups: candidateGroups.filter((group) => group.repaired).length,
      attemptedGames: options.gamesPerCohort * 2,
      games: candidate.length,
      uniquePairs: candidateSeeds.size,
      cohortCounts,
      requiredMarkers: candidateGroups.filter((group) => group.marker !== null).length,
      allRequiredMarkersValid: true,
      allCoverageFull: true,
      allModelVersionsValid: true,
      exclusions,
    },
    evaluation,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath !== undefined) {
    await writeFile(options.outputPath, serialized, { flag: "wx" });
  }
  process.stdout.write(serialized);
  return result;
}

async function main(): Promise<void> {
  await runAzurePairedEvaluation(parseOptions(process.argv.slice(2)));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
