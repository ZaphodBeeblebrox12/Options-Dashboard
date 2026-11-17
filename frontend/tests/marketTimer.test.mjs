import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatISTClock,
  getMarketTimerState,
  parseMarketTimestamp,
} from '../src/marketTimer.js';

const EQUITY_HOURS = ['09:15', '15:30'];
const ist = (value) => parseMarketTimestamp(value);

test('naive database timestamps are interpreted as IST and explicit zones are preserved', () => {
  const naive = ist('2026-11-18 09:15:00');
  const utc = ist('2026-11-18T03:45:00Z');
  assert.equal(naive.getTime(), utc.getTime());
  assert.equal(formatISTClock(utc), '09:15:00');
});

test('countdowns align to the configured session open', () => {
  const state = getMarketTimerState(ist('2026-11-18 09:17:18'), EQUITY_HOURS);
  assert.equal(state.status, 'OPEN');
  assert.equal(state.frames.find((frame) => frame.label === '5M').value, '00:02:42');
  assert.equal(state.frames.find((frame) => frame.label === '15M').value, '00:12:42');
  assert.equal(state.frames.find((frame) => frame.label === '4H').value, '03:57:42');
});

test('pre-open state shows the time until the instrument session starts', () => {
  const state = getMarketTimerState(ist('2026-11-18 08:30:00'), EQUITY_HOURS);
  assert.equal(state.status, 'PRE-OPEN');
  assert.equal(state.footer, 'OPENS IN 00:45:00');
  assert.ok(state.frames.every((frame) => frame.value === '--:--:--'));
});

test('the final partial candle is capped at the configured market close', () => {
  const state = getMarketTimerState(ist('2026-11-18 15:29:00'), EQUITY_HOURS);
  assert.equal(state.status, 'OPEN');
  assert.ok(state.frames.every((frame) => frame.value === '00:01:00'));
  assert.equal(getMarketTimerState(ist('2026-11-18 15:30:00'), EQUITY_HOURS).status, 'CLOSED');
});

test('weekends do not display active countdowns', () => {
  const state = getMarketTimerState(ist('2026-11-21 10:00:00'), EQUITY_HOURS);
  assert.equal(state.status, 'WEEKEND');
  assert.ok(state.frames.every((frame) => frame.value === '--:--:--'));
});

test('MCX uses its configured 09:00–23:30 session', () => {
  const state = getMarketTimerState(ist('2026-11-18 23:29:30'), ['09:00', '23:30']);
  assert.equal(state.status, 'OPEN');
  assert.ok(state.frames.every((frame) => frame.value === '00:00:30'));
  assert.equal(state.sessionLabel, '09:00–23:30 IST');
});

test('a backend-reported closure suppresses countdowns during nominal session hours', () => {
  const state = getMarketTimerState(ist('2026-11-18 11:00:00'), EQUITY_HOURS, false);
  assert.equal(state.status, 'CLOSED');
  assert.ok(state.frames.every((frame) => frame.value === '--:--:--'));
});

test('missing replay timestamps do not invent a clock time', () => {
  const state = getMarketTimerState(null, EQUITY_HOURS);
  assert.equal(state.status, 'WAITING');
  assert.equal(state.clock, '--:--:--');
});
