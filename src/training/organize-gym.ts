import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReplayCorpus,
  parseOfficialReplayJsonl,
  serializeOfficialReplay,
  validateChampionshipReplay,
} from "./replay-corpus.js";

async function filesRecursively(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : [child];
  }));
  return nested.flat();
}

function replaySeed(path: string): number | undefined {
  const match = /^game-(-?\d+)\.jsonl$/u.exec(basename(path));
  if (match?.[1] === undefined) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

export interface OrganizeGymResult {
  organized: number;
  rejected: number;
}

export async function organizeGym(
  inputDirectory: string,
  outputDirectory: string,
): Promise<OrganizeGymResult> {
  const replayFiles = (await filesRecursively(inputDirectory))
    .filter((path) => replaySeed(path) !== undefined)
    .sort();
  const rejected: unknown[] = [];
  let organized = 0;
  for (const replayFile of replayFiles) {
    const parts = relative(inputDirectory, replayFile).split(sep);
    const runId = parts[0] ?? "unknown-run";
    const lane = parts.length > 2 ? parts[1] : undefined;
    const seed = replaySeed(replayFile)!;
    try {
      const replay = parseOfficialReplayJsonl(await readFile(replayFile, "utf8"));
      validateChampionshipReplay(replay);
      const corpus = buildReplayCorpus(replay, {
        source: "gym",
        runId,
        seed,
      });
      const directory = join(
        outputDirectory,
        runId,
        ...(lane === undefined ? [] : [lane]),
        replay.metadata.id,
      );
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(
          join(directory, "record.jsonl"),
          serializeOfficialReplay(replay),
          { flag: "wx" },
        ),
        writeFile(
          join(directory, "summary.json"),
          `${JSON.stringify(corpus.summary, null, 2)}\n`,
          { flag: "wx" },
        ),
        writeFile(
          join(directory, "observations.jsonl"),
          corpus.observations.map((item) => JSON.stringify(item)).join("\n") + "\n",
          { flag: "wx" },
        ),
      ]);
      organized += 1;
    } catch (error) {
      rejected.push({
        replayFile,
        error: error instanceof Error ? error.message : "Unknown replay error",
      });
    }
  }
  if (rejected.length > 0) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      join(outputDirectory, "migration-rejected.jsonl"),
      rejected.map((item) => JSON.stringify(item)).join("\n") + "\n",
      { flag: "wx" },
    );
  }
  return { organized, rejected: rejected.length };
}

async function main(): Promise<void> {
  const [inputDirectory, outputDirectory] = process.argv.slice(2);
  if (inputDirectory === undefined || outputDirectory === undefined) {
    throw new Error("Usage: organize-gym <input-directory> <output-directory>");
  }
  console.log(JSON.stringify(await organizeGym(inputDirectory, outputDirectory)));
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
