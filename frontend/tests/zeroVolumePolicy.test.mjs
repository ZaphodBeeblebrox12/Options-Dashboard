import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldHideZeroVolumeStrike,
  ZERO_VOLUME_OTM_THRESHOLD_PCT,
} from '../src/zeroVolumePolicy.js';

const zero = { volume: 0 };
const active = { volume: 1 };

test('uses a 5 percent distance threshold', () => {
  assert.equal(ZERO_VOLUME_OTM_THRESHOLD_PCT, 5);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10500, 10000), true);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 9500, 10000), true);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10499, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 9501, 10000), false);
});

test('hides the reported SENSEX strikes at the 5 percent threshold', () => {
  const sensexSpot = 83157.77;
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 88700, sensexSpot), true);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 88300, sensexSpot), true);
});

test('both CE and PE volumes must be exactly zero', () => {
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10600, 10000), true);
  assert.equal(shouldHideZeroVolumeStrike(active, zero, 10600, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, active, 9400, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike({ volume: null }, zero, 10600, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike({ volume: '0' }, zero, 10600, 10000), false);
});

test('does not hide near-spot zero-volume strikes', () => {
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10000, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 10400, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 9600, 10000), false);
});

test('missing or invalid spot/strike never hides a row', () => {
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 12000, null), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 12000, 0), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, NaN, 10000), false);
  assert.equal(shouldHideZeroVolumeStrike(zero, zero, 12000, Infinity), false);
  assert.equal(shouldHideZeroVolumeStrike(undefined, zero, 12000, 10000), false);
});
