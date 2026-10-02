import type { Coordinate, GameState } from "../api/types.js";
import { DIRECTIONS, coordinateKey, moveCoordinate } from "./board.js";

export type FoodSpawnRandomSource = () => number;

function normalizedRandom(random: FoodSpawnRandomSource): number {
  const value = random();
  if (!Number.isFinite(value)) {
    throw new Error("Food-spawn random source must return a finite number");
  }
  return Math.max(0, Math.min(1 - Number.EPSILON, value));
}

function availableFoodCells(state: GameState): Coordinate[] {
  const occupied = new Set(state.board.food.map(coordinateKey));
  for (const snake of state.board.snakes) {
    for (const segment of snake.body) {
      occupied.add(coordinateKey(segment));
    }
    for (const direction of DIRECTIONS) {
      occupied.add(coordinateKey(moveCoordinate(snake.head, direction)));
    }
  }

  const available: Coordinate[] = [];
  for (let x = 0; x < state.board.width; x += 1) {
    for (let y = 0; y < state.board.height; y += 1) {
      const candidate = { x, y };
      if (!occupied.has(coordinateKey(candidate))) {
        available.push(candidate);
      }
    }
  }
  return available;
}

function foodToAdd(state: GameState, random: FoodSpawnRandomSource): number {
  const minimumFood = Math.max(
    0,
    Math.floor(state.game.ruleset.settings.minimumFood),
  );
  const missing = minimumFood - state.board.food.length;
  if (missing > 0) {
    return missing;
  }

  const chance = Math.max(
    0,
    Math.min(100, state.game.ruleset.settings.foodSpawnChance),
  );
  if (chance <= 0) {
    return 0;
  }
  const roll = Math.floor(normalizedRandom(random) * 100);
  // Match maps.Standard.checkFoodNeedingPlacement's integer predicate.
  return 100 - roll < chance ? 1 : 0;
}

/**
 * Samples the Standard map's post-turn food placement without mutating state.
 * Hazards remain eligible, matching the official Standard map behavior.
 */
export function sampleStandardFoodSpawn(
  state: GameState,
  random: FoodSpawnRandomSource,
): GameState {
  if (state.game.ruleset.name !== "standard" || state.game.map !== "standard") {
    return state;
  }

  const count = foodToAdd(state, random);
  if (count === 0) {
    return state;
  }

  const available = availableFoodCells(state);
  const additions: Coordinate[] = [];
  const maximum = Math.min(count, available.length);
  for (let index = 0; index < maximum; index += 1) {
    const selectedIndex = index + Math.floor(
      normalizedRandom(random) * (available.length - index),
    );
    const selected = available[selectedIndex];
    const current = available[index];
    if (selected === undefined || current === undefined) {
      break;
    }
    available[index] = selected;
    available[selectedIndex] = current;
    additions.push({ ...selected });
  }

  if (additions.length === 0) {
    return state;
  }
  return {
    ...state,
    board: {
      ...state.board,
      food: [...state.board.food.map((food) => ({ ...food })), ...additions],
    },
  };
}
