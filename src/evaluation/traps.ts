import type { Coordinate } from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  moveCoordinate,
} from "../domain/board.js";
import { floodFill, relativeSpace } from "./flood-fill.js";

export type EnclosureRisk = "low" | "moderate" | "high" | "critical";

export interface TrapAnalysis {
  reachableCells: number;
  relativeSpace: number;
  spaceMargin: number;
  hasEnoughSpace: boolean;
  openExits: number;
  deadEnds: ReadonlySet<string>;
  bottlenecks: ReadonlySet<string>;
  isCulDeSac: boolean;
  enclosureRisk: EnclosureRisk;
}

function reachableNeighbours(
  coordinate: Coordinate,
  reachable: ReadonlySet<string>,
): string[] {
  return DIRECTIONS.map((direction) => moveCoordinate(coordinate, direction))
    .map(coordinateKey)
    .filter((key) => reachable.has(key));
}

function articulationPoints(
  originKey: string,
  coordinates: ReadonlyMap<string, Coordinate>,
  reachable: ReadonlySet<string>,
): Set<string> {
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parents = new Map<string, string | undefined>();
  const points = new Set<string>();
  let time = 0;

  function visit(key: string): void {
    const coordinate = coordinates.get(key);
    if (coordinate === undefined) {
      return;
    }

    time += 1;
    discovery.set(key, time);
    low.set(key, time);
    let children = 0;

    for (const nextKey of reachableNeighbours(coordinate, reachable)) {
      if (!discovery.has(nextKey)) {
        children += 1;
        parents.set(nextKey, key);
        visit(nextKey);
        low.set(key, Math.min(low.get(key) ?? time, low.get(nextKey) ?? time));

        const isRoot = parents.get(key) === undefined;
        if (
          (isRoot && children > 1) ||
          (!isRoot && (low.get(nextKey) ?? 0) >= (discovery.get(key) ?? 0))
        ) {
          points.add(key);
        }
      } else if (nextKey !== parents.get(key)) {
        low.set(
          key,
          Math.min(low.get(key) ?? time, discovery.get(nextKey) ?? time),
        );
      }
    }
  }

  parents.set(originKey, undefined);
  visit(originKey);
  points.delete(originKey);
  return points;
}

export function analyzeTraps(
  origin: Coordinate,
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
  snakeLength: number,
): TrapAnalysis {
  const fill = floodFill(origin, width, height, blocked);
  const originKey = coordinateKey(origin);
  const originCoordinate = fill.coordinates.get(originKey);
  const openExits =
    originCoordinate === undefined
      ? 0
      : reachableNeighbours(originCoordinate, fill.reachable).length;
  const deadEnds = new Set<string>();

  for (const [key, coordinate] of fill.coordinates) {
    if (
      key !== originKey &&
      reachableNeighbours(coordinate, fill.reachable).length <= 1
    ) {
      deadEnds.add(key);
    }
  }

  const bottlenecks = articulationPoints(
    originKey,
    fill.coordinates,
    fill.reachable,
  );
  const spaceMargin = fill.size - snakeLength;
  const hasEnoughSpace = spaceMargin >= 0;
  const isCulDeSac = fill.size > 1 && openExits <= 1;
  let enclosureRisk: EnclosureRisk = "low";

  if (!hasEnoughSpace) {
    enclosureRisk = "critical";
  } else if (isCulDeSac) {
    enclosureRisk = "high";
  } else if (relativeSpace(fill.size, snakeLength) < 2 || bottlenecks.size > 0) {
    enclosureRisk = "moderate";
  }

  return {
    reachableCells: fill.size,
    relativeSpace: relativeSpace(fill.size, snakeLength),
    spaceMargin,
    hasEnoughSpace,
    openExits,
    deadEnds,
    bottlenecks,
    isCulDeSac,
    enclosureRisk,
  };
}
