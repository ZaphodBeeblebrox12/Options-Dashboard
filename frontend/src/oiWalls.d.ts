export interface OiWallInput {
  strike: number;
  option_type: string;
  oi?: number | null;
}

export interface OiWalls {
  ceWall: number | null;
  peWall: number | null;
}

export function computeOiWalls(
  options: readonly OiWallInput[] | null | undefined,
): OiWalls;
