import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";
import { evaluateEligibility } from "./corpus-manifest.js";
import { parseReplaySummary } from "./replay-corpus.js";

export const AZURE_TRAINING_SELECTION_SCHEMA_VERSION = 1 as const;

export type TrainingCohort = "legacy" | "challenger";
export type TrainingSelectionRole =
  | "train-pilot"
  | "train-main"
  | "validation"
  | "test"
  | "reserve";

export interface AzureBlobArtifactReference {
  name: string;
  etag: string;
  contentLength: number;
}

export interface AzureTrainingSelectionCandidate {
  gameId: string;
  cohort: TrainingCohort;
  finalTurn: number;
  winnerName: string;
  isDraw: boolean;
  record: AzureBlobArtifactReference;
  summary: AzureBlobArtifactReference;
  searchObservations: AzureBlobArtifactReference;
}

export interface AzureTrainingSelectionEntry
  extends AzureTrainingSelectionCandidate {
  schemaVersion: typeof AZURE_TRAINING_SELECTION_SCHEMA_VERSION;
  selectionId: string;
  roles: readonly TrainingSelectionRole[];
  samplingWeight: number;
  preparationShard: number;
}

export interface AzureTrainingSelectionOptions {
  selectionId: string;
  pilotGamesPerCohort: number;
  mainGamesPerCohort: number;
  validationGamesPerCohort: number;
  testGamesPerCohort: number;
  preparationShards: number;
}

interface AzureSelectionEnvironment extends AzureTrainingSelectionOptions {
  storageAccountUrl: string;
  storageContainer: string;
  sourcePrefix: string;
  outputPrefix: string;
  downloadConcurrency: number;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableOrderKey(selectionId: string, purpose: string, gameId: string): string {
  return createHash("sha256")
    .update(`${selectionId}|${purpose}|${gameId}`)
    .digest("hex");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function selectAzureTrainingGames(
  candidates: readonly AzureTrainingSelectionCandidate[],
  options: Readonly<AzureTrainingSelectionOptions>,
): AzureTrainingSelectionEntry[] {
  if (options.selectionId.trim().length === 0) {
    throw new Error("selectionId must be non-empty");
  }
  const pilotCount = positiveInteger(
    options.pilotGamesPerCohort,
    "pilotGamesPerCohort",
  );
  const mainCount = positiveInteger(
    options.mainGamesPerCohort,
    "mainGamesPerCohort",
  );
  const validationCount = positiveInteger(
    options.validationGamesPerCohort,
    "validationGamesPerCohort",
  );
  const testCount = positiveInteger(
    options.testGamesPerCohort,
    "testGamesPerCohort",
  );
  const preparationShards = positiveInteger(
    options.preparationShards,
    "preparationShards",
  );
  if (pilotCount > mainCount) {
    throw new Error("pilotGamesPerCohort cannot exceed mainGamesPerCohort");
  }
  const results: AzureTrainingSelectionEntry[] = [];
  for (const cohort of ["legacy", "challenger"] as const) {
    const cohortCandidates = candidates
      .filter((candidate) => candidate.cohort === cohort)
      .sort((a, b) => {
        const left = stableOrderKey(options.selectionId, "split", a.gameId);
        const right = stableOrderKey(options.selectionId, "split", b.gameId);
        return left.localeCompare(right) || a.gameId.localeCompare(b.gameId);
      });
    const required = validationCount + testCount + mainCount;
    if (cohortCandidates.length < required) {
      throw new Error(
        `Cohort ${cohort} needs ${required} games; found ${cohortCandidates.length}`,
      );
    }
    const validation = new Set(
      cohortCandidates.slice(0, validationCount).map((item) => item.gameId),
    );
    const test = new Set(
      cohortCandidates.slice(validationCount, validationCount + testCount)
        .map((item) => item.gameId),
    );
    const mainCandidates = cohortCandidates.slice(
      validationCount + testCount,
      required,
    );
    const main = new Set(mainCandidates.map((item) => item.gameId));
    const pilot = new Set(
      [...mainCandidates].sort((a, b) => {
        const left = stableOrderKey(options.selectionId, "pilot", a.gameId);
        const right = stableOrderKey(options.selectionId, "pilot", b.gameId);
        return left.localeCompare(right) || a.gameId.localeCompare(b.gameId);
      }).slice(0, pilotCount).map((item) => item.gameId),
    );
    for (const candidate of cohortCandidates) {
      const roles: TrainingSelectionRole[] = validation.has(candidate.gameId)
        ? ["validation"]
        : test.has(candidate.gameId)
        ? ["test"]
        : main.has(candidate.gameId)
        ? [
          ...(pilot.has(candidate.gameId) ? ["train-pilot" as const] : []),
          "train-main",
        ]
        : ["reserve"];
      const shardKey = stableOrderKey(
        options.selectionId,
        "prepared-shard",
        candidate.gameId,
      );
      const preparationShard = Number.parseInt(shardKey.slice(0, 8), 16) %
        preparationShards;
      results.push({
        schemaVersion: AZURE_TRAINING_SELECTION_SCHEMA_VERSION,
        selectionId: options.selectionId,
        ...candidate,
        roles,
        samplingWeight: 1,
        preparationShard,
      });
    }
  }
  return results.sort((a, b) =>
    a.cohort.localeCompare(b.cohort) || a.gameId.localeCompare(b.gameId)
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  return positiveInteger(Number.parseInt(raw, 10), name);
}

function environmentOptions(): AzureSelectionEnvironment {
  return {
    storageAccountUrl: requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    storageContainer: process.env.AZURE_STORAGE_CONTAINER ?? "battlesnake-corpus",
    sourcePrefix: requiredEnvironment("TRAINING_SOURCE_PREFIX").replace(/\/$/u, ""),
    outputPrefix: requiredEnvironment("TRAINING_SELECTION_PREFIX").replace(/\/$/u, ""),
    selectionId: requiredEnvironment("TRAINING_SELECTION_ID"),
    pilotGamesPerCohort: integerEnvironment(
      "TRAINING_PILOT_GAMES_PER_COHORT",
      2_500,
    ),
    mainGamesPerCohort: integerEnvironment(
      "TRAINING_MAIN_GAMES_PER_COHORT",
      10_000,
    ),
    validationGamesPerCohort: integerEnvironment(
      "TRAINING_VALIDATION_GAMES_PER_COHORT",
      1_000,
    ),
    testGamesPerCohort: integerEnvironment(
      "TRAINING_TEST_GAMES_PER_COHORT",
      1_000,
    ),
    preparationShards: integerEnvironment("TRAINING_PREPARATION_SHARDS", 60),
    downloadConcurrency: integerEnvironment("TRAINING_DOWNLOAD_CONCURRENCY", 32),
  };
}

interface ArtifactGroup {
  cohort: TrainingCohort;
  record?: AzureBlobArtifactReference;
  summary?: AzureBlobArtifactReference;
  searchObservations?: AzureBlobArtifactReference;
}

function artifactReference(
  name: string,
  etag: string | undefined,
  contentLength: number | undefined,
): AzureBlobArtifactReference {
  if (etag === undefined || contentLength === undefined) {
    throw new Error(`Blob ${name} is missing immutable properties`);
  }
  return { name, etag, contentLength };
}

async function listArtifactGroups(
  container: ContainerClient,
  sourcePrefix: string,
): Promise<Map<string, ArtifactGroup>> {
  const groups = new Map<string, ArtifactGroup>();
  for await (const blob of container.listBlobsFlat({ prefix: `${sourcePrefix}/` })) {
    const filename = blob.name.split("/").at(-1);
    if (
      filename !== "record.jsonl" && filename !== "summary.json" &&
      filename !== "search-observations.jsonl"
    ) continue;
    const directory = blob.name.slice(0, -(filename.length + 1));
    const relativeParts = directory.slice(sourcePrefix.length + 1).split("/");
    const cohort = relativeParts[0];
    if (cohort !== "legacy" && cohort !== "challenger") continue;
    const group = groups.get(directory) ?? { cohort };
    const reference = artifactReference(
      blob.name,
      blob.properties.etag,
      blob.properties.contentLength,
    );
    if (filename === "record.jsonl") group.record = reference;
    else if (filename === "summary.json") group.summary = reference;
    else group.searchObservations = reference;
    groups.set(directory, group);
  }
  return groups;
}

async function mapConcurrent<T, Result>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await operation(items[index]!);
      }
    },
  ));
  return results;
}

async function candidatesFromBlob(
  container: ContainerClient,
  groups: ReadonlyMap<string, ArtifactGroup>,
  concurrency: number,
): Promise<{ candidates: AzureTrainingSelectionCandidate[]; rejected: number }> {
  const complete = [...groups.values()].filter((group) =>
    group.record !== undefined && group.summary !== undefined &&
    group.searchObservations !== undefined
  );
  let rejected = groups.size - complete.length;
  const values = await mapConcurrent(complete, concurrency, async (group) => {
    try {
      const summaryBuffer = await container
        .getBlockBlobClient(group.summary!.name)
        .downloadToBuffer(0, undefined, {
          conditions: { ifMatch: group.summary!.etag },
        });
      const summary = parseReplaySummary(summaryBuffer.toString("utf8"));
      if (!evaluateEligibility(summary).eligible) return undefined;
      return {
        gameId: summary.gameId,
        cohort: group.cohort,
        finalTurn: summary.finalTurn,
        winnerName: summary.winnerName,
        isDraw: summary.isDraw,
        record: group.record!,
        summary: group.summary!,
        searchObservations: group.searchObservations!,
      } satisfies AzureTrainingSelectionCandidate;
    } catch {
      return undefined;
    }
  });
  const candidates = values.filter(
    (value): value is AzureTrainingSelectionCandidate => value !== undefined,
  );
  rejected += values.length - candidates.length;
  return { candidates, rejected };
}

async function runAzureSelection(): Promise<void> {
  const options = environmentOptions();
  const container = new BlobServiceClient(
    options.storageAccountUrl,
    new DefaultAzureCredential(),
  ).getContainerClient(options.storageContainer);
  const groups = await listArtifactGroups(container, options.sourcePrefix);
  console.log(JSON.stringify({
    event: "training_selection_blobs_indexed",
    artifactGroups: groups.size,
  }));
  const { candidates, rejected } = await candidatesFromBlob(
    container,
    groups,
    options.downloadConcurrency,
  );
  const entries = selectAzureTrainingGames(candidates, options);
  const manifestText = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const roleCounts = Object.fromEntries(
    (["train-pilot", "train-main", "validation", "test", "reserve"] as const)
      .map((role) => [role, entries.filter((entry) => entry.roles.includes(role)).length]),
  );
  const summary = {
    schemaVersion: AZURE_TRAINING_SELECTION_SCHEMA_VERSION,
    selectionId: options.selectionId,
    sourcePrefix: options.sourcePrefix,
    createdAt: new Date().toISOString(),
    eligibleGames: candidates.length,
    rejectedGames: rejected,
    cohorts: {
      legacy: entries.filter((entry) => entry.cohort === "legacy").length,
      challenger: entries.filter((entry) => entry.cohort === "challenger").length,
    },
    roles: roleCounts,
    preparationShards: options.preparationShards,
    manifestDigest: sha256(manifestText),
  };
  await container.getBlockBlobClient(`${options.outputPrefix}/manifest.jsonl`)
    .uploadData(Buffer.from(manifestText), { conditions: { ifNoneMatch: "*" } });
  await container.getBlockBlobClient(`${options.outputPrefix}/summary.json`)
    .uploadData(Buffer.from(`${JSON.stringify(summary, null, 2)}\n`), {
      conditions: { ifNoneMatch: "*" },
    });
  await container.getBlockBlobClient(`${options.outputPrefix}/_SUCCESS.json`)
    .uploadData(Buffer.from(`${JSON.stringify({
      selectionId: options.selectionId,
      manifestDigest: summary.manifestDigest,
      eligibleGames: candidates.length,
    }, null, 2)}\n`), { conditions: { ifNoneMatch: "*" } });
  console.log(JSON.stringify({ event: "training_selection_complete", ...summary }));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void runAzureSelection().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
