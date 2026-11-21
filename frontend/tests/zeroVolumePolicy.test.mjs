import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isConfirmedZeroVolume,
  shouldHideZeroVolumeStrike,
} from '../src/zeroVolumePolicy.js';

const verifiedZero = { volume: 0, volume_valid: true, oi: 1200, ltp: 45 };
const migratedZero = {
  volume: 0,
  volume_valid: 0,
  source_age_sec: null,
  oi: 1200,
  ltp: 45,
};

test('verified zero is accepted from live boolean and persisted integer flags', () => {
  assert.equal(isConfirmedZeroVolume(verifiedZero), true);
  assert.equal(isConfirmedZeroVolume({ ...verifiedZero, volume_valid: 1 }), true);
});

test('two verified zero sides hide a strike', () => {
  assert.equal(shouldHideZeroVolumeStrike(verifiedZero, { ...verifiedZero, volume_valid: 1 }), true);
});

test('migrated legacy zeros are inferred only during replay with quote and OI evidence', () => {
  assert.equal(isConfirmedZeroVolume(migratedZero, true), true);
  assert.equal(shouldHideZeroVolumeStrike(migratedZero, { ...migratedZero }, true), true);
  assert.equal(isConfirmedZeroVolume(migratedZero, false), false);
});

test('legacy inference requires positive OI and LTP on each side', () => {
  assert.equal(isConfirmedZeroVolume({ ...migratedZero, oi: 0 }, true), false);
  assert.equal(isConfirmedZeroVolume({ ...migratedZero, ltp: 0 }, true), false);
  assert.equal(shouldHideZeroVolumeStrike(migratedZero, { ...migratedZero, oi: 0 }, true), false);
  assert.equal(shouldHideZeroVolumeStrike(migratedZero, undefined, true), false);
});

test('legacy inference is disabled when source freshness telemetry exists', () => {
  assert.equal(isConfirmedZeroVolume({ ...migratedZero, source_age_sec: 0 }, true), false);
  assert.equal(isConfirmedZeroVolume({ ...migratedZero, source_age_sec: 30 }, true), false);
});

test('unknown, missing, non-zero, and malformed volume values stay visible', () => {
  assert.equal(isConfirmedZeroVolume({ volume: 0, oi: 100, ltp: 10 }, true), false);
  assert.equal(isConfirmedZeroVolume({ volume: null, volume_valid: true }, true), false);
  assert.equal(isConfirmedZeroVolume({ volume: 10, volume_valid: true }, true), false);
  assert.equal(isConfirmedZeroVolume({ volume: '0', volume_valid: true }, true), false);
  assert.equal(shouldHideZeroVolumeStrike(verifiedZero, { volume: 0, volume_valid: false }), false);
});
