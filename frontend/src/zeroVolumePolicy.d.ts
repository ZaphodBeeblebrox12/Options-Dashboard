export interface VolumeEligibleContract {
  volume?: number | null;
  volume_valid?: boolean | number | null;
}

export declare const MIN_ELIGIBLE_VOLUME: 2;

export declare function hasEligibleVolumeContract(
  contract: VolumeEligibleContract | null | undefined,
): boolean;

export declare function shouldHideStrikeForVolume(
  ce: VolumeEligibleContract | null | undefined,
  pe: VolumeEligibleContract | null | undefined,
): boolean;
