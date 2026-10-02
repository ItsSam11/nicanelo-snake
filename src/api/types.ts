export interface Coordinate {
  x: number;
  y: number;
}

export interface Customizations {
  color: string;
  head: string;
  tail: string;
}

export interface Battlesnake {
  id: string;
  name: string;
  health: number;
  body: Coordinate[];
  head: Coordinate;
  length: number;
  latency?: string;
  shout?: string;
  squad?: string;
  customizations?: Customizations;
}

export interface RulesetSettings {
  foodSpawnChance: number;
  minimumFood: number;
  hazardDamagePerTurn: number;
  royale?: {
    shrinkEveryNTurns: number;
  };
}

export interface Game {
  id: string;
  ruleset: {
    name: string;
    version: string;
    settings: RulesetSettings;
  };
  map: string;
  source: string;
  timeout: number;
}

export interface Board {
  height: number;
  width: number;
  food: Coordinate[];
  hazards: Coordinate[];
  snakes: Battlesnake[];
}

export interface GameState {
  game: Game;
  turn: number;
  board: Board;
  you: Battlesnake;
}

export type Direction = "up" | "down" | "left" | "right";

export interface MoveResponse {
  move: Direction;
  shout?: string;
}

export interface InfoResponse {
  apiversion: "1";
  author?: string;
  color?: string;
  head?: string;
  tail?: string;
  version?: string;
}
