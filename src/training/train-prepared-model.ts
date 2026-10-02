import { pathToFileURL } from "node:url";
import { trainPreparedStrategyModel } from "./prepared-training.js";

interface CliOptions {
  datasetManifest: string;
  outputPath: string;
  modelVersion: string;
  workers?: number;
  epochs?: number;
  minimumGames?: number;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseTrainPreparedModelOptions(argv: readonly string[]): CliOptions {
  const values: Partial<CliOptions> = {
    outputPath: "models/candidates/latest.json",
    epochs: 200,
    minimumGames: 20,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? "argument"}`);
    switch (flag) {
      case "--dataset-manifest":
        values.datasetManifest = value;
        break;
      case "--output":
        values.outputPath = value;
        break;
      case "--model-version":
        values.modelVersion = value;
        break;
      case "--workers":
        values.workers = positiveInteger(value, flag);
        break;
      case "--epochs":
        values.epochs = positiveInteger(value, flag);
        break;
      case "--min-games":
        values.minimumGames = positiveInteger(value, flag);
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }
  if (values.datasetManifest === undefined) {
    throw new Error("--dataset-manifest is required");
  }
  if (values.modelVersion === undefined || values.modelVersion.trim() === "") {
    throw new Error("--model-version is required");
  }
  return values as CliOptions;
}

async function main(): Promise<void> {
  const options = parseTrainPreparedModelOptions(process.argv.slice(2));
  const result = await trainPreparedStrategyModel({
    ...options,
    progress: (entry) => console.log(JSON.stringify(entry)),
  });
  console.log(JSON.stringify({
    event: "prepared_model_candidate_written",
    path: options.outputPath,
    modelVersion: result.model.modelVersion,
    corpusGames: result.model.training.corpusGames,
    workers: result.workers,
    elapsedMs: Number(result.elapsedMs.toFixed(3)),
    rssBytes: result.rssBytes,
    offlineGatePassed: result.model.training.offlineGatePassed,
    baselineValidation: result.model.training.baselineValidation,
    candidateValidation: result.model.training.candidateValidation,
  }));
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
