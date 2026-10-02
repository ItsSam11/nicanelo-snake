import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { STRATEGY_FEATURE_SET_VERSION } from "../model/feature-set.js";
import { POLICY_FEATURE_NAMES, VALUE_FEATURE_NAMES } from "./model-training.js";
import { PUCT_POLICY_TARGET_VERSION } from "./search-targets.js";
import {
  POLICY_CANDIDATE_LIMIT,
  POLICY_RECORD_DOUBLES,
  PREPARED_TRAINING_SCHEMA_VERSION,
  preparedFileName,
  VALUE_RECORD_DOUBLES,
  type PreparedPartitionCounts,
  type PreparedTrainingDataset,
  type PreparedTrainingShard,
} from "./prepared-training-format.js";

interface FinalizeOptions {
  accountUrl: string;
  containerName: string;
  selectionManifestBlob: string;
  outputPrefix: string;
  stage: "pilot" | "main";
  expectedJobs: number;
  expectedTrainingGames: number;
  expectedValidationGames: number;
  validationConcurrency: number;
}

interface PreparationMarker {
  schemaVersion: 2;
  preparedTrainingSchemaVersion: typeof PREPARED_TRAINING_SCHEMA_VERSION;
  featureSetVersion: typeof STRATEGY_FEATURE_SET_VERSION;
  policyTargetVersion: typeof PUCT_POLICY_TARGET_VERSION;
  policyFeatureNames: readonly string[];
  valueFeatureNames: readonly string[];
  binaryFormat: {
    numberType: "float64-le";
    policyRecordDoubles: number;
    valueRecordDoubles: number;
    maximumPolicyCandidates: number;
  };
  stage: "pilot" | "main";
  selectionManifestBlob: string;
  selectionManifestDigest: string;
  preparationShardIndex: number;
  preparationShardCount: number;
  sourceGames: number;
  workers: number;
  shards: readonly PreparedTrainingShard[];
  elapsedMs: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function environmentOptions(): FinalizeOptions {
  const stage = requiredEnvironment("TRAINING_DATASET_STAGE");
  if (stage !== "pilot" && stage !== "main") {
    throw new Error("TRAINING_DATASET_STAGE must be pilot or main");
  }
  return {
    accountUrl: requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: process.env.AZURE_STORAGE_CONTAINER ?? "battlesnake-corpus",
    selectionManifestBlob: requiredEnvironment(
      "TRAINING_SELECTION_MANIFEST_BLOB",
    ),
    outputPrefix: requiredEnvironment("TRAINING_PREPARED_PREFIX").replace(/\/$/u, ""),
    stage,
    expectedJobs: positiveIntegerEnvironment(
      "TRAINING_PREPARATION_SHARD_COUNT",
      60,
    ),
    expectedTrainingGames: positiveIntegerEnvironment(
      "TRAINING_EXPECTED_TRAINING_GAMES",
      stage === "pilot" ? 5_000 : 20_000,
    ),
    expectedValidationGames: positiveIntegerEnvironment(
      "TRAINING_EXPECTED_VALIDATION_GAMES",
      2_000,
    ),
    validationConcurrency: positiveIntegerEnvironment(
      "TRAINING_VALIDATION_CONCURRENCY",
      16,
    ),
  };
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function sameStrings(
  value: unknown,
  expected: readonly string[],
): value is string[] {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

export function validatePreparationProvenance(value: unknown): void {
  const candidate = object(value, "Azure preparation marker");
  const binary = object(candidate.binaryFormat, "prepared binary format");
  if (
    candidate.schemaVersion !== 2 ||
    candidate.preparedTrainingSchemaVersion !==
      PREPARED_TRAINING_SCHEMA_VERSION ||
    candidate.featureSetVersion !== STRATEGY_FEATURE_SET_VERSION ||
    candidate.policyTargetVersion !== PUCT_POLICY_TARGET_VERSION ||
    !sameStrings(candidate.policyFeatureNames, POLICY_FEATURE_NAMES) ||
    !sameStrings(candidate.valueFeatureNames, VALUE_FEATURE_NAMES) ||
    binary.numberType !== "float64-le" ||
    binary.policyRecordDoubles !== POLICY_RECORD_DOUBLES ||
    binary.valueRecordDoubles !== VALUE_RECORD_DOUBLES ||
    binary.maximumPolicyCandidates !== POLICY_CANDIDATE_LIMIT
  ) {
    throw new Error(
      "Preparation marker is incompatible with the current training format",
    );
  }
}

function counts(value: unknown): PreparedPartitionCounts {
  const candidate = object(value, "prepared partition counts");
  for (const key of ["games", "policyPrior", "opponentPolicy", "value"] as const) {
    if (!Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0) {
      throw new Error(`Invalid prepared partition count ${key}`);
    }
  }
  return candidate as unknown as PreparedPartitionCounts;
}

function shard(value: unknown): PreparedTrainingShard {
  const candidate = object(value, "prepared shard");
  if (
    !Number.isSafeInteger(candidate.index) || (candidate.index as number) < 0 ||
    typeof candidate.directory !== "string" || candidate.directory.length === 0
  ) throw new Error("Invalid prepared shard identity");
  const training = counts(candidate.training);
  const validation = counts(candidate.validation);
  const files = object(candidate.files, "prepared shard files");
  for (const partition of ["training", "validation"] as const) {
    for (const head of ["policyPrior", "opponentPolicy", "value"] as const) {
      const name = preparedFileName(partition, head);
      const metadata = object(files[name], `prepared file ${name}`);
      if (
        !Number.isSafeInteger(metadata.bytes) || (metadata.bytes as number) < 0 ||
        typeof metadata.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(metadata.digest)
      ) throw new Error(`Invalid prepared file metadata for ${name}`);
      const recordDoubles = head === "value"
        ? VALUE_RECORD_DOUBLES
        : POLICY_RECORD_DOUBLES;
      if (
        metadata.bytes !== (partition === "training" ? training : validation)[head] *
          recordDoubles * 8
      ) throw new Error(`Prepared file size disagrees with counts for ${name}`);
    }
  }
  return {
    index: candidate.index as number,
    directory: candidate.directory,
    training,
    validation,
    files: files as PreparedTrainingShard["files"],
  };
}

function marker(value: unknown): PreparationMarker {
  const candidate = object(value, "Azure preparation marker");
  validatePreparationProvenance(candidate);
  const binary = object(candidate.binaryFormat, "prepared binary format");
  if (
    candidate.schemaVersion !== 2 ||
    (candidate.stage !== "pilot" && candidate.stage !== "main") ||
    typeof candidate.selectionManifestBlob !== "string" ||
    typeof candidate.selectionManifestDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.selectionManifestDigest) ||
    !Number.isSafeInteger(candidate.preparationShardIndex) ||
    !Number.isSafeInteger(candidate.preparationShardCount) ||
    !Number.isSafeInteger(candidate.sourceGames) ||
    !Number.isSafeInteger(candidate.workers) ||
    !Array.isArray(candidate.shards) || candidate.shards.length !== 1 ||
    typeof candidate.elapsedMs !== "number" || !Number.isFinite(candidate.elapsedMs)
  ) throw new Error("Invalid Azure preparation marker");
  return {
    schemaVersion: 2,
    preparedTrainingSchemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
    featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
    policyTargetVersion: PUCT_POLICY_TARGET_VERSION,
    policyFeatureNames: [...POLICY_FEATURE_NAMES],
    valueFeatureNames: [...VALUE_FEATURE_NAMES],
    binaryFormat: {
      numberType: "float64-le",
      policyRecordDoubles: binary.policyRecordDoubles as number,
      valueRecordDoubles: binary.valueRecordDoubles as number,
      maximumPolicyCandidates: binary.maximumPolicyCandidates as number,
    },
    stage: candidate.stage,
    selectionManifestBlob: candidate.selectionManifestBlob,
    selectionManifestDigest: candidate.selectionManifestDigest,
    preparationShardIndex: candidate.preparationShardIndex as number,
    preparationShardCount: candidate.preparationShardCount as number,
    sourceGames: candidate.sourceGames as number,
    workers: candidate.workers as number,
    shards: [shard(candidate.shards[0])],
    elapsedMs: candidate.elapsedMs,
  };
}

function sumCounts(
  shards: readonly PreparedTrainingShard[],
  partition: "training" | "validation",
): PreparedPartitionCounts {
  return shards.reduce((total, item) => ({
    games: total.games + item[partition].games,
    policyPrior: total.policyPrior + item[partition].policyPrior,
    opponentPolicy: total.opponentPolicy + item[partition].opponentPolicy,
    value: total.value + item[partition].value,
  }), { games: 0, policyPrior: 0, opponentPolicy: 0, value: 0 });
}

async function mapConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await operation(items[index]!);
      }
    },
  ));
}

async function validateRemoteFiles(
  container: ContainerClient,
  shards: readonly PreparedTrainingShard[],
  concurrency: number,
): Promise<void> {
  const files = shards.flatMap((item) =>
    Object.entries(item.files).map(([name, metadata]) => ({
      name: `${item.directory}/${name}`,
      bytes: metadata.bytes,
    }))
  );
  await mapConcurrent(files, concurrency, async (file) => {
    const properties = await container.getBlockBlobClient(file.name).getProperties();
    if (properties.contentLength !== file.bytes) {
      throw new Error(`Blob ${file.name} has an unexpected size`);
    }
  });
}

async function runAzureFinalizer(): Promise<void> {
  const options = environmentOptions();
  const container = new BlobServiceClient(
    options.accountUrl,
    new DefaultAzureCredential(),
  ).getContainerClient(options.containerName);
  const selectionManifest = await container
    .getBlockBlobClient(options.selectionManifestBlob).downloadToBuffer();
  const authoritativeSelectionDigest = sha256(selectionManifest);
  const markerNames = Array.from({ length: options.expectedJobs }, (_, index) =>
    `${options.outputPrefix}/jobs/job-${index.toString().padStart(3, "0")}.json`
  );
  const markers = await Promise.all(markerNames.map(async (name) =>
    marker(JSON.parse((await container.getBlockBlobClient(name)
      .downloadToBuffer()).toString("utf8")) as unknown)
  ));
  const selectionDigest = markers[0]!.selectionManifestDigest;
  if (selectionDigest !== authoritativeSelectionDigest) {
    throw new Error("Preparation markers do not match the selection manifest");
  }
  for (const [index, item] of markers.entries()) {
    if (
      item.stage !== options.stage ||
      item.selectionManifestBlob !== options.selectionManifestBlob ||
      item.selectionManifestDigest !== selectionDigest ||
      item.preparationShardIndex !== index ||
      item.preparationShardCount !== options.expectedJobs ||
      item.shards[0]!.index !== index ||
      item.sourceGames !==
        item.shards[0]!.training.games + item.shards[0]!.validation.games
    ) throw new Error(`Preparation marker ${index} is inconsistent`);
  }
  const shards = markers.flatMap((item) => item.shards)
    .sort((a, b) => a.index - b.index);
  if (new Set(shards.map((item) => item.directory)).size !== shards.length) {
    throw new Error("Prepared shard directories are not unique");
  }
  await validateRemoteFiles(
    container,
    shards,
    options.validationConcurrency,
  );
  const training = sumCounts(shards, "training");
  const validation = sumCounts(shards, "validation");
  if (
    training.games !== options.expectedTrainingGames ||
    validation.games !== options.expectedValidationGames
  ) {
    throw new Error(
      `Prepared game counts are ${training.games} training and ${validation.games} validation; expected ${options.expectedTrainingGames} and ${options.expectedValidationGames}`,
    );
  }
  const dataset: PreparedTrainingDataset = {
    schemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
    featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
    policyTargetVersion: PUCT_POLICY_TARGET_VERSION,
    createdAt: new Date().toISOString(),
    sourceManifest: options.selectionManifestBlob,
    corpusDigest: sha256(`${selectionDigest}|${options.stage}`),
    corpusGames: training.games + validation.games,
    validationSplit: "selection-manifest-v1",
    policyFeatureNames: POLICY_FEATURE_NAMES,
    valueFeatureNames: VALUE_FEATURE_NAMES,
    binaryFormat: {
      numberType: "float64-le",
      policyRecordDoubles: POLICY_RECORD_DOUBLES,
      valueRecordDoubles: VALUE_RECORD_DOUBLES,
      maximumPolicyCandidates: POLICY_CANDIDATE_LIMIT,
    },
    storage: {
      kind: "azure-blob",
      accountUrl: options.accountUrl,
      containerName: options.containerName,
    },
    totals: { training, validation },
    shards,
  };
  const manifestText = `${JSON.stringify(dataset, null, 2)}\n`;
  const successText = `${JSON.stringify({
    schemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
    featureSetVersion: dataset.featureSetVersion,
    policyTargetVersion: dataset.policyTargetVersion,
    manifestDigest: sha256(manifestText),
    corpusDigest: dataset.corpusDigest,
    corpusGames: dataset.corpusGames,
    trainingGames: training.games,
    validationGames: validation.games,
    preparationJobs: options.expectedJobs,
  }, null, 2)}\n`;
  await container.getBlockBlobClient(`${options.outputPrefix}/manifest.json`)
    .uploadData(Buffer.from(manifestText), { conditions: { ifNoneMatch: "*" } });
  await container.getBlockBlobClient(`${options.outputPrefix}/_SUCCESS.json`)
    .uploadData(Buffer.from(successText), { conditions: { ifNoneMatch: "*" } });
  console.log(JSON.stringify({
    event: "azure_training_dataset_finalized",
    prefix: options.outputPrefix,
    stage: options.stage,
    corpusGames: dataset.corpusGames,
    trainingGames: training.games,
    validationGames: validation.games,
    shards: shards.length,
    manifestDigest: sha256(manifestText),
  }));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void runAzureFinalizer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
