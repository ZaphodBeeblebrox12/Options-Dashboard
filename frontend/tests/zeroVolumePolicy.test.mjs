import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasEligibleVolumeContract,
  isConfirmedZeroVolume,
  shouldHideStrikeForVolume,
  MIN_ELIGIBLE_VOLUME,
} from '../src/zeroVolumePolicy.js';

const volume = (n, valid = true) => ({ volume: n, volume_valid: valid });

test('analytical eligibility requires a verified tick and volume >= 2', () => {
  assert.equal(MIN_ELIGIBLE_VOLUME, 2);
  assert.equal(hasEligibleVolumeContract(volume(0)), false);
  assert.equal(hasEligibleVolumeContract(volume(1)), false);
  assert.equal(hasEligibleVolumeContract(volume(2)), true);
  assert.equal(hasEligibleVolumeContract(volume(3)), true);
  assert.equal(hasEligibleVolumeContract(volume(50, false)), false);
  assert.equal(hasEligibleVolumeContract({ volume: 50 }), false);
});

test('only verified zero-volume contracts count as confirmed zero', () => {
  assert.equal(isConfirmedZeroVolume(volume(0)), true);
  assert.equal(isConfirmedZeroVolume(volume(0, false)), false);
  assert.equal(isConfirmedZeroVolume({ volume: 0 }), false);
  assert.equal(isConfirmedZeroVolume(volume(1)), false);
  assert.equal(isConfirmedZeroVolume(volume(2)), false);
});

test('hide a strike only when both CE and PE are confirmed zero', () => {
  assert.equal(shouldHideStrikeForVolume(volume(0), volume(0)), true);
  assert.equal(shouldHideStrikeForVolume(volume(0), volume(2)), false);
  assert.equal(shouldHideStrikeForVolume(volume(2), volume(0)), false);
  assert.equal(shouldHideStrikeForVolume(volume(0, false), volume(0, false)), false);
  assert.equal(shouldHideStrikeForVolume({ volume: 0 }, { volume: 0 }), false);
  assert.equal(shouldHideStrikeForVolume(undefined, volume(0)), false);
});
