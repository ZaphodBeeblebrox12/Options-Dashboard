import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOiWalls } from '../src/oiWalls.js';

const options = [
  { strike: 24700, option_type: 'CE', oi: 1200, volume: 3, volume_valid: true },
  { strike: 24900, option_type: 'CE', oi: 900, volume: 20, volume_valid: true },
  { strike: 25000, option_type: 'CE', oi: 400, volume: 10, volume_valid: true },
  { strike: 25100, option_type: 'CE', oi: 700, volume: 5, volume_valid: true },
  { strike: 25200, option_type: 'PE', oi: 800, volume: 4, volume_valid: true },
  { strike: 25000, option_type: 'PE', oi: 500, volume: 25, volume_valid: true },
  { strike: 25500, option_type: 'PE', oi: 1100, volume: 6, volume_valid: true },
];

test('GEX overlays select the strongest eligible CE and PE OI concentrations', () => {
  assert.deepEqual(computeOiWalls(options), {
    ceWall: 24700,
    peWall: 25500,
  });
});

test('volume 0 and 1 are excluded independently for each side', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 26000, option_type: 'CE', oi: 90000, volume: 1, volume_valid: true },
    { strike: 26000, option_type: 'PE', oi: 80000, volume: 30, volume_valid: true },
    { strike: 25500, option_type: 'CE', oi: 1000, volume: 2, volume_valid: true },
    { strike: 25500, option_type: 'PE', oi: 1200, volume: 0, volume_valid: true },
  ]), {
    ceWall: 25500,
    peWall: 26000,
  });
});

test('spot crossing above or below a wall cannot change the selected GEX wall', () => {
  assert.deepEqual(computeOiWalls(options, 24800), {
    ceWall: 24700,
    peWall: 25500,
  });
  assert.deepEqual(computeOiWalls(options, 27000), {
    ceWall: 24700,
    peWall: 25500,
  });
});

test('an OI redistribution can move a wall when volume remains eligible', () => {
  const changed = options.map(option =>
    option.option_type === 'CE' && option.strike === 24700
      ? { ...option, oi: 600 }
      : option.option_type === 'CE' && option.strike === 25100
        ? { ...option, oi: 1500 }
        : option
  );
  assert.deepEqual(computeOiWalls(changed), {
    ceWall: 25100,
    peWall: 25500,
  });
});

test('equal eligible OI resolves to the lower strike deterministically', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 25000, option_type: 'CE', oi: 500, volume: 2, volume_valid: true },
    { strike: 24900, option_type: 'CE', oi: 500, volume: 2, volume_valid: true },
    { strike: 25100, option_type: 'PE', oi: 700, volume: 2, volume_valid: true },
    { strike: 25000, option_type: 'PE', oi: 700, volume: 2, volume_valid: true },
  ]), {
    ceWall: 24900,
    peWall: 25000,
  });
});

test('missing and invalid volume cannot create phantom walls', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 25000, option_type: 'CE', oi: 999, volume: 1, volume_valid: true },
    { strike: 25000, option_type: 'PE', oi: 999, volume: null, volume_valid: true },
    { strike: 24900, option_type: 'CE', oi: 1000, volume: 2, volume_valid: true },
  ]), { ceWall: 24900, peWall: null });
});


test('contracts with unverified legacy volume cannot create walls', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 26000, option_type: 'CE', oi: 90000, volume: 500, volume_valid: false },
    { strike: 26000, option_type: 'PE', oi: 80000, volume: 2, volume_valid: true },
    { strike: 25500, option_type: 'CE', oi: 1000, volume: 2, volume_valid: true },
  ]), { ceWall: 25500, peWall: 26000 });
});


test('replay wall selection uses stored volume >=2 without legacy provenance flag', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 26000, option_type: 'CE', oi: 90000, volume: 1, volume_valid: false },
    { strike: 26000, option_type: 'PE', oi: 80000, volume: 200, volume_valid: false },
    { strike: 25500, option_type: 'CE', oi: 1000, volume: 20, volume_valid: false },
  ], 'replay'), {
    ceWall: 25500,
    peWall: 26000,
  });
});

test('live wall selection still requires verified volume', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 26000, option_type: 'CE', oi: 90000, volume: 200, volume_valid: false },
    { strike: 25500, option_type: 'CE', oi: 1000, volume: 20, volume_valid: true },
  ], 'live'), {
    ceWall: 25500,
    peWall: null,
  });
});
