# Standard turn simulator

`simulateTurn` is a pure implementation of the deterministic portion of one
multiplayer Standard-rules turn. It returns a new API-shaped state, elimination
causes, and the terminal result from our snake's perspective.

The implemented order matches the current official Battlesnake rules engine:

1. Apply all moves, add each new head, and remove each final tail segment.
2. Reduce every snake's health by one.
3. Apply configured hazard damage, except where food occupies the same square.
4. Feed surviving snakes, restore health to 100, grow, and remove eaten food.
5. Eliminate snakes for health or bounds before considering their bodies.
6. Resolve self, body, and head-to-head collisions simultaneously.

Random food spawning and map mutations such as Royale shrinking are not
reproducible from an API payload because it omits the engine's RNG state. The
simulator therefore rejects non-Standard rulesets explicitly instead of
silently producing an inexact state.

MCTS separately applies a seeded stochastic food transition for the Standard
map after `simulateTurn`. It first restores `minimumFood`, otherwise applies
`foodSpawnChance`, and samples only cells allowed by the official map policy.
Keeping this outside `simulateTurn` preserves the distinction between an exact
rules transition and a modeled chance outcome.
