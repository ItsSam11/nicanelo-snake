import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { STRATEGY_FEATURE_SET_VERSION } from "../model/feature-set.js";
import {
  AZURE_TRAINING_SELECTION_SCHEMA_VERSION,
  type AzureTrainingSelectionEntry,
  type TrainingSelectionRole,
} from "./azure-training-selection.js";
import type {
  AzurePrepareWorkerData,
  PreparedTrainingFile,
  PreparedTrainingShard,
} from "./prepared-training-format.js";
import { finished } from "node:stream/promises";
import {
  POLICY_CANDIDATE_LIMIT,
  POLICY_RECORD_DOUBLES,
  PREPARED_TRAINING_SCHEMA_VERSION,
  preparedFileName,
  VALUE_RECORD_DOUBLES,
} from "./prepared-training-format.js";
import {
  POLICY_FEATURE_NAMES,
  VALUE_FEATURE_NAMES,
} from "./model-training.js";
import { PUCT_POLICY_TARGET_VERSION } from "./search-targets.js";

interface AzurePreparationOptions {
  accountUrl: string;
  containerName: string;
  selectionManifestBlob: string;
  selectionSuccessBlob: string;
  outputPrefix: string;
  stage: "pilot" | "main";
  preparationShardIndex: number;
  preparationShardCount: number;
  workers: number;
  uploadConcurrency: number;
  outputDirectory: string;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function environmentOptions(): AzurePreparationOptions {
  const selectionManifestBlob = requiredEnvironment(
    "TRAINING_SELECTION_MANIFEST_BLOB",
  );
  const stageValue = requiredEnvironment("TRAINING_DATASET_STAGE");
  if (stageValue !== "pilot" && stageValue !== "main") {
    throw new Error("TRAINING_DATASET_STAGE must be pilot or main");
  }
  const preparationShardCount = integerEnvironment(
    "TRAINING_PREPARATION_SHARD_COUNT",
    60,
  );
  const preparationShardIndex = integerEnvironment(
    "TRAINING_PREPARATION_SHARD_INDEX",
    0,
    0,
  );
  if (preparationShardIndex >= preparationShardCount) {
    throw new Error("TRAINING_PREPARATION_SHARD_INDEX is out of range");
  }
  return {
    accountUrl: requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: process.env.AZURE_STORAGE_CONTAINER ?? "battlesnake-corpus",
    selectionManifestBlob,
    selectionSuccessBlob: process.env.TRAINING_SELECTION_SUCCESS_BLOB ??
      selectionManifestBlob.replace(/manifest\.jsonl$/u, "_SUCCESS.json"),
    outputPrefix: requiredEnvironment("TRAINING_PREPARED_PREFIX").replace(/\/$/u, ""),
    stage: stageValue,
    preparationShardIndex,
    preparationShardCount,
    workers: integerEnvironment(
      "TRAINING_WORKERS",
      Math.max(1, availableParallelism() - 1),
    ),
    uploadConcurrency: integerEnvironment("TRAINING_UPLOAD_CONCURRENCY", 8),
    outputDirectory: process.env.TRAINING_OUTPUT_DIRECTORY ??
      `/tmp/nicanelo-training-${stageValue}-${preparationShardIndex}`,
  };
}

function selectionEntry(value: unknown): AzureTrainingSelectionEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Azure training selection entry");
  }
  const entry = value as Partial<AzureTrainingSelectionEntry>;
  if (
    entry.schemaVersion !== AZURE_TRAINING_SELECTION_SCHEMA_VERSION ||
    typeof entry.selectionId !== "string" ||
    typeof entry.gameId !== "string" ||
    (entry.cohort !== "legacy" && entry.cohort !== "challenger") ||
    !Array.isArray(entry.roles) ||
    !entry.roles.every((role) =>
      ["train-pilot", "train-main", "validation", "test", "reserve"]
        .includes(role)
    ) ||
    !Number.isSafeInteger(entry.preparationShard) ||
    typeof entry.samplingWeight !== "number" ||
    !Number.isFinite(entry.samplingWeight) || entry.samplingWeight <= 0
  ) {
    throw new Error("Invalid Azure training selection entry");
  }
  return entry as AzureTrainingSelectionEntry;
}

async function selectedEntries(
  container: ContainerClient,
  options: Readonly<AzurePreparationOptions>,
): Promise<{ entries: AzureTrainingSelectionEntry[]; manifestDigest: string }> {
  const [manifestBuffer, successBuffer] = await Promise.all([
    container.getBlockBlobClient(options.selectionManifestBlob).downloadToBuffer(),
    container.getBlockBlobClient(options.selectionSuccessBlob).downloadToBuffer(),
  ]);
  const manifestText = manifestBuffer.toString("utf8");
  const success = JSON.parse(successBuffer.toString("utf8")) as {
    manifestDigest?: unknown;
  };
  const manifestDigest = sha256(manifestText);
  if (success.manifestDigest !== manifestDigest) {
    throw new Error("Azure training selection success marker does not match");
  }
  const trainingRole: TrainingSelectionRole = options.stage === "pilot"
    ? "train-pilot"
    : "train-main";
  const entries = manifestText.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => selectionEntry(JSON.parse(line) as unknown))
    .filter((entry) =>
      entry.preparationShard === options.preparationShardIndex &&
      (entry.roles.includes(trainingRole) || entry.roles.includes("validation"))
    )
    .sort((a, b) => a.gameId.localeCompare(b.gameId));
  if (entries.length === 0) {
    throw new Error("Azure preparation shard has no selected games");
  }
  return { entries, manifestDigest };
}

async function runWorker(
  data: Readonly<AzurePrepareWorkerData>,
): Promise<PreparedTrainingShard> {
  const worker = new Worker(
    new URL("./prepared-training-worker.js", import.meta.url),
    { workerData: data },
  );
  return await new Promise<PreparedTrainingShard>((resolvePromise, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    worker.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        "type" in message && message.type === "prepared" &&
        "result" in message
      ) {
        settle(() => resolvePromise(message.result as PreparedTrainingShard));
      }
    });
    worker.on("error", (error) => settle(() => reject(error)));
    worker.on("exit", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`Azure preparation worker exited ${code}`)));
      } else if (!settled) {
        settle(() => reject(new Error("Azure preparation worker returned no result")));
      }
    });
  });
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

async function uploadShards(
  container: ContainerClient,
  options: Readonly<AzurePreparationOptions>,
  shards: readonly PreparedTrainingShard[],
): Promise<PreparedTrainingShard[]> {
  const uploaded: PreparedTrainingShard[] = [];
  for (const shard of shards) {
    const localDirectory = join(options.outputDirectory, shard.directory);
    const remoteDirectory = `${options.outputPrefix}/${shard.directory}`;
    const files = (await readdir(localDirectory)).sort();
    await mapConcurrent(files, options.uploadConcurrency, async (file) => {
      await container.getBlockBlobClient(`${remoteDirectory}/${file}`).uploadFile(
        join(localDirectory, file),
        { conditions: { ifNoneMatch: "*" } },
      );
    });
    uploaded.push({ ...shard, directory: remoteDirectory });
  }
  return uploaded;
}

function sumCounts(
  shards: readonly PreparedTrainingShard[],
  partition: "training" | "validation",
): PreparedTrainingShard[typeof partition] {
  return shards.reduce((total, shard) => ({
    games: total.games + shard[partition].games,
    policyPrior: total.policyPrior + shard[partition].policyPrior,
    opponentPolicy: total.opponentPolicy + shard[partition].opponentPolicy,
    value: total.value + shard[partition].value,
  }), { games: 0, policyPrior: 0, opponentPolicy: 0, value: 0 });
}

async function fileMetadata(path: string): Promise<PreparedTrainingFile> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return {
    bytes: (await stat(path)).size,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

async function mergeWorkerShards(
  outputRoot: string,
  shardIndex: number,
  parts: readonly PreparedTrainingShard[],
): Promise<PreparedTrainingShard> {
  const directory = `shard-${shardIndex.toString().padStart(3, "0")}`;
  const outputDirectory = join(outputRoot, directory);
  await mkdir(outputDirectory, { recursive: false });
  for (const partition of ["training", "validation"] as const) {
    for (const head of ["policyPrior", "opponentPolicy", "value"] as const) {
      const name = preparedFileName(partition, head);
      const destination = join(outputDirectory, name);
      await writeFile(destination, Buffer.alloc(0), { flag: "wx" });
      for (const part of [...parts].sort((a, b) => a.index - b.index)) {
        await appendFile(
          destination,
          await readFile(join(outputRoot, part.directory, name)),
        );
      }
    }
  }
  const names = (await readdir(outputDirectory)).sort();
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await fileMetadata(join(outputDirectory, name)),
  ] as const)));
  return {
    index: shardIndex,
    directory,
    training: sumCounts(parts, "training"),
    validation: sumCounts(parts, "validation"),
    files,
  };
}

async function runAzurePreparation(): Promise<void> {
  const startedAt = performance.now();
  const options = environmentOptions();
  const container = new BlobServiceClient(
    options.accountUrl,
    new DefaultAzureCredential(),
  ).getContainerClient(options.containerName);
  const { entries, manifestDigest } = await selectedEntries(container, options);
  const workers = Math.min(options.workers, entries.length);
  await mkdir(options.outputDirectory, { recursive: false });
  const partitions = Array.from({ length: workers }, () =>
    [] as AzureTrainingSelectionEntry[]
  );
  entries.forEach((entry, index) => partitions[index % workers]!.push(entry));
  const workerShards = (await Promise.all(partitions.map((partition, workerIndex) => {
    const shardIndex = options.preparationShardIndex * 100 + workerIndex;
    const directory = `shard-${shardIndex.toString().padStart(4, "0")}`;
    return runWorker({
      mode: "azure-prepare",
      accountUrl: options.accountUrl,
      containerName: options.containerName,
      entries: partition,
      outputDirectory: join(options.outputDirectory, directory),
      shardIndex,
    });
  }))).sort((a, b) => a.index - b.index);
  const mergedShard = await mergeWorkerShards(
    options.outputDirectory,
    options.preparationShardIndex,
    workerShards,
  );
  const uploadedShards = await uploadShards(container, options, [mergedShard]);
  const marker = {
    schemaVersion: 2,
    preparedTrainingSchemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
    featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
    policyTargetVersion: PUCT_POLICY_TARGET_VERSION,
    policyFeatureNames: POLICY_FEATURE_NAMES,
    valueFeatureNames: VALUE_FEATURE_NAMES,
    binaryFormat: {
      numberType: "float64-le",
      policyRecordDoubles: POLICY_RECORD_DOUBLES,
      valueRecordDoubles: VALUE_RECORD_DOUBLES,
      maximumPolicyCandidates: POLICY_CANDIDATE_LIMIT,
    },
    stage: options.stage,
    selectionManifestBlob: options.selectionManifestBlob,
    selectionManifestDigest: manifestDigest,
    preparationShardIndex: options.preparationShardIndex,
    preparationShardCount: options.preparationShardCount,
    sourceGames: entries.length,
    workers,
    shards: uploadedShards,
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
  };
  const markerName = `${options.outputPrefix}/jobs/job-${
    options.preparationShardIndex.toString().padStart(3, "0")
  }.json`;
  await container.getBlockBlobClient(markerName).uploadData(
    Buffer.from(`${JSON.stringify(marker, null, 2)}\n`),
    { conditions: { ifNoneMatch: "*" } },
  );
  console.log(JSON.stringify({
    event: "azure_training_preparation_complete",
    marker: markerName,
    ...marker,
  }));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void runAzurePreparation().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
