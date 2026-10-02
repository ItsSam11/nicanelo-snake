import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PersistenceRecord } from "../persistence/types.js";
import {
  buildReplayCorpus,
  serializeOfficialReplay,
} from "./replay-corpus.js";
import {
  officialReplaysFromTelemetry,
  parseTelemetryJson,
} from "./telemetry-corpus.js";

async function filesRecursively(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : [child];
  }));
  return nested.flat();
}

function isTelemetryEvent(path: string): boolean {
  return /^\d{6}-(game_start|move|game_end)-.+\.json$/u.test(basename(path));
}

export async function organizeTelemetry(
  inputDirectory: string,
  outputDirectory: string,
): Promise<number> {
  const files = (await filesRecursively(inputDirectory))
    .filter(isTelemetryEvent)
    .sort();
  const records = await Promise.all(files.map(async (file) =>
    parseTelemetryJson(await readFile(file, "utf8"))
  ));
  const groups = new Map<string, PersistenceRecord[]>();
  for (const item of records) {
    const group = groups.get(item.gameId) ?? [];
    group.push(item);
    groups.set(item.gameId, group);
  }
  const replays = officialReplaysFromTelemetry(records);
  for (const replay of replays) {
    const group = groups.get(replay.metadata.id) ?? [];
    const first = [...group].sort((a, b) =>
      a.recordedAt.localeCompare(b.recordedAt)
    )[0];
    const day = first?.recordedAt.slice(0, 10) ?? "unknown-date";
    const directory = join(outputDirectory, day, replay.metadata.id);
    const modelVersions = group.map((item) => item.modelVersion);
    const corpus = buildReplayCorpus(replay, {
      source: "live",
      modelVersions,
    });
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
  }
  return replays.length;
}

async function main(): Promise<void> {
  const [inputDirectory, outputDirectory] = process.argv.slice(2);
  if (inputDirectory === undefined || outputDirectory === undefined) {
    throw new Error("Usage: organize-telemetry <input-directory> <output-directory>");
  }
  const games = await organizeTelemetry(inputDirectory, outputDirectory);
  console.log(JSON.stringify({ event: "telemetry_organized", games }));
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
