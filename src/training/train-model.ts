import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTrainingCorpusManifest } from "./corpus-manifest.js";
import { trainStrategyModel } from "./model-training.js";

export interface TrainModelCliOptions {
  corpusManifest: string;
  outputPath: string;
  modelVersion: string;
  minimumGames: number;
  epochs: number;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseTrainModelOptions(
  argv: readonly string[],
): TrainModelCliOptions {
  const values: Partial<TrainModelCliOptions> = {
    outputPath: "models/candidates/latest.json",
    minimumGames: 20,
    epochs: 200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    switch (flag) {
      case "--corpus-manifest":
        values.corpusManifest = value;
        break;
      case "--output":
        values.outputPath = value;
        break;
      case "--model-version":
        values.modelVersion = value;
        break;
      case "--min-games":
        values.minimumGames = positiveInteger(value, flag);
        break;
      case "--epochs":
        values.epochs = positiveInteger(value, flag);
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }
  if (values.modelVersion === undefined || values.modelVersion.trim() === "") {
    throw new Error("--model-version is required");
  }
  if (values.corpusManifest === undefined) {
    throw new Error("--corpus-manifest is required");
  }
  return values as TrainModelCliOptions;
}

export async function runTraining(
  options: Readonly<TrainModelCliOptions>,
): Promise<void> {
  const games = await loadTrainingCorpusManifest(options.corpusManifest);
  const model = trainStrategyModel(games, {
    modelVersion: options.modelVersion,
    minimumGames: options.minimumGames,
    epochs: options.epochs,
  });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(model, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(JSON.stringify({
    event: "model_candidate_written",
    path: options.outputPath,
    modelVersion: model.modelVersion,
    corpusGames: model.training.corpusGames,
    offlineGatePassed: model.training.offlineGatePassed,
    baselineValidation: model.training.baselineValidation,
    candidateValidation: model.training.candidateValidation,
  }));
}

async function main(): Promise<void> {
  await runTraining(parseTrainModelOptions(process.argv.slice(2)));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
