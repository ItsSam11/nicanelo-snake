import type { Battlesnake, Coordinate, GameState } from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  isInsideBoard,
  moveCoordinate,
  sameCoordinate,
} from "../domain/board.js";

export interface PathResult {
  path: readonly Coordinate[];
  distance: number;
}

function reconstructPath(
  destinationKey: string,
  coordinates: ReadonlyMap<string, Coordinate>,
  parents: ReadonlyMap<string, string | undefined>,
): Coordinate[] {
  const reversed: Coordinate[] = [];
  let key: string | undefined = destinationKey;

  while (key !== undefined) {
    const coordinate = coordinates.get(key);
    if (coordinate === undefined) {
      throw new Error(`Missing coordinate while reconstructing path: ${key}`);
    }
    reversed.push({ ...coordinate });
    key = parents.get(key);
  }

  return reversed.reverse();
}

export function shortestPathToAny(
  origin: Coordinate,
  targets: readonly Coordinate[],
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
): PathResult | undefined {
  if (!isInsideBoard(origin, width, height) || targets.length === 0) {
    return undefined;
  }

  const targetKeys = new Set(targets.map(coordinateKey));
  const originKey = coordinateKey(origin);
  const queue: Coordinate[] = [{ ...origin }];
  const visited = new Set<string>([originKey]);
  const coordinates = new Map<string, Coordinate>([[originKey, { ...origin }]]);
  const parents = new Map<string, string | undefined>([[originKey, undefined]]);
  let queueIndex = 0;

  if (targetKeys.has(originKey)) {
    return { path: [{ ...origin }], distance: 0 };
  }

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (current === undefined) {
      continue;
    }
    const currentKey = coordinateKey(current);

    for (const direction of DIRECTIONS) {
      const next = moveCoordinate(current, direction);
      const nextKey = coordinateKey(next);
      if (
        !isInsideBoard(next, width, height) ||
        blocked.has(nextKey) ||
        visited.has(nextKey)
      ) {
        continue;
      }

      visited.add(nextKey);
      coordinates.set(nextKey, next);
      parents.set(nextKey, currentKey);
      if (targetKeys.has(nextKey)) {
        const path = reconstructPath(nextKey, coordinates, parents);
        return { path, distance: path.length - 1 };
      }
      queue.push(next);
    }
  }

  return undefined;
}

export function shortestPath(
  origin: Coordinate,
  target: Coordinate,
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
): PathResult | undefined {
  return shortestPathToAny(origin, [target], width, height, blocked);
}

interface HealthSearchNode {
  coordinate: Coordinate;
  health: number;
  parentIndex?: number;
}

function reconstructHealthPath(
  nodes: readonly HealthSearchNode[],
  destinationIndex: number,
): Coordinate[] {
  const reversed: Coordinate[] = [];
  let index: number | undefined = destinationIndex;

  while (index !== undefined) {
    const node: HealthSearchNode | undefined = nodes[index];
    if (node === undefined) {
      throw new Error("Invalid health-search parent index");
    }
    reversed.push({ ...node.coordinate });
    index = node.parentIndex;
  }

  return reversed.reverse();
}

/**
 * Finds the shortest static path to food that the snake can survive. Food is
 * resolved before starvation elimination, and food inside a hazard suppresses
 * hazard damage on the consuming turn, matching the turn simulator.
 * Opponent races and future body movement are intentionally not predicted.
 */
export function shortestSurvivablePathToFood(
  state: GameState,
  snake: Battlesnake,
  blocked: ReadonlySet<string>,
): PathResult | undefined {
  if (state.board.food.length === 0) {
    return undefined;
  }

  const foodKeys = new Set(state.board.food.map(coordinateKey));
  const hazardKeys = new Set(state.board.hazards.map(coordinateKey));
  const originKey = coordinateKey(snake.head);
  if (foodKeys.has(originKey)) {
    return { path: [{ ...snake.head }], distance: 0 };
  }

  const nodes: HealthSearchNode[] = [
    { coordinate: { ...snake.head }, health: snake.health },
  ];
  const bestHealth = new Map<string, number>([[originKey, snake.health]]);
  let queueIndex = 0;

  while (queueIndex < nodes.length) {
    const currentIndex = queueIndex;
    const current = nodes[queueIndex];
    queueIndex += 1;
    if (current === undefined) {
      continue;
    }

    for (const direction of DIRECTIONS) {
      const next = moveCoordinate(current.coordinate, direction);
      const nextKey = coordinateKey(next);
      if (
        !isInsideBoard(next, state.board.width, state.board.height) ||
        blocked.has(nextKey)
      ) {
        continue;
      }

      const isFood = foodKeys.has(nextKey);
      let nextHealth = current.health - 1;
      if (isFood) {
        nextHealth = 100;
      } else if (hazardKeys.has(nextKey)) {
        nextHealth -= state.game.ruleset.settings.hazardDamagePerTurn;
      }

      if (nextHealth <= 0 || nextHealth <= (bestHealth.get(nextKey) ?? -1)) {
        continue;
      }

      const nextNode: HealthSearchNode = {
        coordinate: next,
        health: nextHealth,
        parentIndex: currentIndex,
      };
      nodes.push(nextNode);
      bestHealth.set(nextKey, nextHealth);
      const nextIndex = nodes.length - 1;

      if (isFood) {
        const path = reconstructHealthPath(nodes, nextIndex);
        return { path, distance: path.length - 1 };
      }
    }
  }

  return undefined;
}

/** Static tail reachability; a duplicated tail is not assumed to vacate. */
export function shortestPathToOwnTail(
  state: GameState,
  snake: Battlesnake,
  blocked: ReadonlySet<string>,
): PathResult | undefined {
  const tail = snake.body.at(-1);
  if (tail === undefined) {
    return undefined;
  }

  const tailOccurrences = snake.body.filter((segment) =>
    sameCoordinate(segment, tail),
  ).length;
  if (tailOccurrences > 1) {
    return undefined;
  }

  const passable = new Set(blocked);
  passable.delete(coordinateKey(tail));
  return shortestPath(
    snake.head,
    tail,
    state.board.width,
    state.board.height,
    passable,
  );
}
