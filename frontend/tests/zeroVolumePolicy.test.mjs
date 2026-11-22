import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasEligibleVolumeContract,
  shouldHideStrikeForVolume,
  MIN_ELIGIBLE_VOLUME,
} from '../src/zeroVolumePolicy.js';

const volume = n => ({ volume: n, volume_valid: true });

test('uses a minimum contract volume of 2 and requires a verified tick', () => {
  assert.equal(MIN_ELIGIBLE_VOLUME, 2);
  assert.equal(hasEligibleVolumeContract(volume(0)), false);
  assert.equal(hasEligibleVolumeContract(volume(1)), false);
  assert.equal(hasEligibleVolumeContract(volume(2)), true);
  assert.equal(hasEligibleVolumeContract(volume(3)), true);
  assert.equal(hasEligibleVolumeContract({ volume: 50, volume_valid: false }), false);
  assert.equal(hasEligibleVolumeContract({ volume: 50 }), false);
  assert.equal(hasEligibleVolumeContract({ volume: 2, volume_valid: 0 }), false);
});

test('CE and PE eligibility is independent', () => {
  assert.equal(shouldHideStrikeForVolume(volume(0), volume(1)), true);
  assert.equal(shouldHideStrikeForVolume(volume(1), volume(0)), true);
  assert.equal(shouldHideStrikeForVolume(volume(2), volume(0)), false);
  assert.equal(shouldHideStrikeForVolume(volume(0), volume(2)), false);
  assert.equal(shouldHideStrikeForVolume(volume(2), volume(2)), false);
});

test('missing, string and invalid volume are ineligible', () => {
  assert.equal(hasEligibleVolumeContract(undefined), false);
  assert.equal(hasEligibleVolumeContract(volume(null)), false);
  assert.equal(hasEligibleVolumeContract(volume('2')), false);
  assert.equal(hasEligibleVolumeContract(volume(NaN)), false);
  assert.equal(hasEligibleVolumeContract(volume(Infinity)), false);
});
