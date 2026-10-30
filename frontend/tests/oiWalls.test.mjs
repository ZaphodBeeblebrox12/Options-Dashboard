import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOiWalls } from '../src/oiWalls.js';

const options = [
  { strike: 24700, option_type: 'CE', oi: 1200 },
  { strike: 24900, option_type: 'CE', oi: 900 },
  { strike: 25000, option_type: 'CE', oi: 400 },
  { strike: 25100, option_type: 'CE', oi: 700 },
  { strike: 25200, option_type: 'PE', oi: 800 },
  { strike: 25000, option_type: 'PE', oi: 500 },
  { strike: 25500, option_type: 'PE', oi: 1100 },
];

test('GEX overlays select the strongest CE and PE OI across the loaded chain', () => {
  // The CE wall is below spot and the PE wall is above spot. Both remain
  // valid OI walls; current spot position does not filter either one.
  assert.deepEqual(computeOiWalls(options), {
    ceWall: 24700,
    peWall: 25500,
  });
});

test('spot crossing above or below a wall cannot change the selected GEX wall', () => {
  // Legacy extra arguments are deliberately ignored; spot is not part of
  // the shared wall-selector API.
  assert.deepEqual(computeOiWalls(options, 24800), {
    ceWall: 24700,
    peWall: 25500,
  });
  assert.deepEqual(computeOiWalls(options, 27000), {
    ceWall: 24700,
    peWall: 25500,
  });
});

test('an OI redistribution can move a GEX wall', () => {
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

test('equal OI resolves to the lower strike deterministically', () => {
  assert.deepEqual(computeOiWalls([
    { strike: 25000, option_type: 'CE', oi: 500 },
    { strike: 24900, option_type: 'CE', oi: 500 },
    { strike: 25100, option_type: 'PE', oi: 700 },
    { strike: 25000, option_type: 'PE', oi: 700 },
  ]), {
    ceWall: 24900,
    peWall: 25000,
  });
});

test('empty, missing, and invalid rows do not create phantom walls', () => {
  assert.deepEqual(computeOiWalls(null), { ceWall: null, peWall: null });
  assert.deepEqual(computeOiWalls([
    { strike: Number.NaN, option_type: 'CE', oi: 999 },
    { strike: 25000, option_type: 'OTHER', oi: 999 },
    { strike: 25000, option_type: 'PE', oi: Number.NaN },
  ]), { ceWall: null, peWall: null });
});
