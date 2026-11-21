import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldHideZeroVolumeStrike,
  ZERO_VOLUME_OTM_THRESHOLD_PCT,
} from '../src/zeroVolumePolicy.js';

const zero = { volume: 0 };
const active = { volume: 1 };

test('uses a 10 percent distance threshold', () => {
  assert.equal(ZERO_VOLUME_OTM_THRESHOLD_PCT, 10);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 11000, 10000), true);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 9000, 10000), true);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10999, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 9001, 10000), false);
});

test('both CE and PE volumes must be exactly zero', () => {
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 11200, 10000), true);
  assert.equal(shouldHideZeroVolumeStrike(active, zero, 11200, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, active, 8800, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike({ volume: null }, zero, 11200, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike({ volume: '0' }, zero, 11200, 10000), false);
});

test('does not hide near-spot zero-volume strikes', () => {
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10000, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10500, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 9500, 10000), false);
});

test('missing or invalid spot/strike never hides a row', () => {
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 12000, null), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 12000, 0), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, NaN, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 12000, Infinity), false);
  assert.equal(shouldHideZeroVolumeStrike(undefined, zero, 12000, 10000), false);
});
