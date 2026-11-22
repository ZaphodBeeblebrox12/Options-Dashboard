export interface VolumeEligibleContract {
  volume?: number | null;
  volume_valid?: boolean | number | null;
  oi?: number | null;
  ltp?: number | null;
}

export declare const MIN_ELIGIBLE_VOLUME: 2;

export declare function hasEligibleVolumeContract(
  contract: VolumeEligibleContract | null | undefined,
): boolean;

export declare function hasStoredEligibleVolumeContract(
  contract: VolumeEligibleContract | null | undefined,
): boolean;

export declare function isConfirmedZeroVolume(
  contract: VolumeEligibleContract | null | undefined,
): boolean;

export declare function shouldHideStrikeForVolume(
  ce: VolumeEligibleContract | null | undefined,
  pe: VolumeEligibleContract | null | undefined,
): boolean;
