import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { trainPreparedStrategyModel } from "./prepared-training.js";

interface AzureTrainingOptions {
  accountUrl: string;
  containerName: string;
  preparedPrefix: string;
  outputPrefix: string;
  modelVersion: string;
  workers: number;
  epochs: number;
  minimumGames: number;
  temporaryDirectory: string;
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

function environmentOptions(): AzureTrainingOptions {
  const preparedPrefix = requiredEnvironment("TRAINING_PREPARED_PREFIX")
    .replace(/\/$/u, "");
  const modelVersion = requiredEnvironment("TRAINING_MODEL_VERSION");
  return {
    accountUrl: requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: process.env.AZURE_STORAGE_CONTAINER ?? "battlesnake-corpus",
    preparedPrefix,
    outputPrefix: requiredEnvironment("TRAINING_MODEL_OUTPUT_PREFIX")
      .replace(/\/$/u, ""),
    modelVersion,
    workers: positiveIntegerEnvironment(
      "TRAINING_WORKERS",
      Math.max(1, availableParallelism() - 1),
    ),
    epochs: positiveIntegerEnvironment("TRAINING_EPOCHS", 200),
    minimumGames: positiveIntegerEnvironment("TRAINING_MINIMUM_GAMES", 20),
    temporaryDirectory: process.env.TRAINING_OUTPUT_DIRECTORY ??
      `/tmp/nicanelo-model-${randomUUID()}`,
  };
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function runAzureTraining(): Promise<void> {
  const options = environmentOptions();
  const container = new BlobServiceClient(
    options.accountUrl,
    new DefaultAzureCredential(),
  ).getContainerClient(options.containerName);
  await mkdir(options.temporaryDirectory, { recursive: false });
  const [manifestBuffer, successBuffer] = await Promise.all([
    container.getBlockBlobClient(`${options.preparedPrefix}/manifest.json`)
      .downloadToBuffer(),
    container.getBlockBlobClient(`${options.preparedPrefix}/_SUCCESS.json`)
      .downloadToBuffer(),
  ]);
  const manifestPath = join(options.temporaryDirectory, "manifest.json");
  const modelPath = join(options.temporaryDirectory, "model.json");
  await Promise.all([
    writeFile(manifestPath, manifestBuffer, { flag: "wx" }),
    writeFile(
      join(options.temporaryDirectory, "_SUCCESS.json"),
      successBuffer,
      { flag: "wx" },
    ),
  ]);
  const result = await trainPreparedStrategyModel({
    datasetManifest: manifestPath,
    outputPath: modelPath,
    modelVersion: options.modelVersion,
    workers: options.workers,
    epochs: options.epochs,
    minimumGames: options.minimumGames,
    progress: (entry) => console.log(JSON.stringify(entry)),
  });
  const modelBuffer = await readFile(modelPath);
  const modelDigest = sha256(modelBuffer);
  const summary = {
    schemaVersion: 1,
    modelVersion: result.model.modelVersion,
    createdAt: result.model.createdAt,
    preparedPrefix: options.preparedPrefix,
    preparedManifestDigest: sha256(manifestBuffer),
    corpusDigest: result.model.training.corpusDigest,
    featureSetVersion: result.model.training.featureSetVersion,
    corpusGames: result.model.training.corpusGames,
    epochs: result.model.training.epochs,
    workers: result.workers,
    elapsedMs: Number(result.elapsedMs.toFixed(3)),
    peakRssBytes: result.rssBytes,
    offlineGatePassed: result.model.training.offlineGatePassed,
    baselineValidation: result.model.training.baselineValidation,
    candidateValidation: result.model.training.candidateValidation,
    modelDigest,
  };
  const modelBlob = `${options.outputPrefix}/model.json`;
  const summaryBlob = `${options.outputPrefix}/summary.json`;
  const successBlob = `${options.outputPrefix}/_SUCCESS.json`;
  await container.getBlockBlobClient(modelBlob).uploadData(modelBuffer, {
    conditions: { ifNoneMatch: "*" },
  });
  await container.getBlockBlobClient(summaryBlob).uploadData(
    Buffer.from(`${JSON.stringify(summary, null, 2)}\n`),
    { conditions: { ifNoneMatch: "*" } },
  );
  await container.getBlockBlobClient(successBlob).uploadData(
    Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      modelVersion: result.model.modelVersion,
      modelBlob,
      modelDigest,
      summaryBlob,
      offlineGatePassed: result.model.training.offlineGatePassed,
    }, null, 2)}\n`),
    { conditions: { ifNoneMatch: "*" } },
  );
  console.log(JSON.stringify({
    event: "azure_model_training_complete",
    modelBlob,
    summaryBlob,
    successBlob,
    ...summary,
  }));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void runAzureTraining().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
