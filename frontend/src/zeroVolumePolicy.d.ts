export interface ZeroVolumeOptionSide {
  volume?: number | null;
}

export declare const ZERO_VOLUME_OTM_THRESHOLD_PCT: 10;

export declare function shouldHideZeroVolumeStrike(
  ce: ZeroVolumeOptionSide | null | undefined,
  pe: ZeroVolumeOptionSide | null | undefined,
  strike: number,
  spot: number | null | undefined
): boolean;
