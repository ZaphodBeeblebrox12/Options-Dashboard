export interface ZeroVolumeOptionSide {
  volume?: number | null;
  volume_valid?: boolean | number | null;
  oi?: number | null;
  ltp?: number | null;
  source_age_sec?: number | null;
}

export declare function isConfirmedZeroVolume(
  side?: ZeroVolumeOptionSide | null,
  allowLegacyReplay?: boolean
): boolean;

export declare function shouldHideZeroVolumeStrike(
  ce?: ZeroVolumeOptionSide | null,
  pe?: ZeroVolumeOptionSide | null,
  allowLegacyReplay?: boolean
): boolean;
