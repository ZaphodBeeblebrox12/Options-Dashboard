export interface OiWallInput {
  strike: number;
  option_type: string;
  oi?: number | null;
  volume?: number | null;
  volume_valid?: boolean | number | null;
}

export interface OiWalls {
  ceWall: number | null;
  peWall: number | null;
}

export function computeOiWalls(
  options: readonly OiWallInput[] | null | undefined,
  mode?: 'live' | 'replay',
): OiWalls;
