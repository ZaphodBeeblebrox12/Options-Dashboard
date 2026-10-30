import test from 'node:test';
import assert from 'node:assert/strict';
import { canReturnToLive, isSourceFresh, resolveLiveStatus } from '../src/replayPolicy.js';

test('finishing a historical day never switches to live when the market is open today', () => {
  assert.equal(canReturnToLive(true, '2026-10-27', '2026-10-29', true), false);
});

test('finishing the current date returns to live only when the market is open', () => {
  assert.equal(canReturnToLive(true, '2026-10-29', '2026-10-29', true), true);
  assert.equal(canReturnToLive(true, '2026-10-29', '2026-10-29', false), false);
});

test('seeking before the final snapshot never switches to live', () => {
  assert.equal(canReturnToLive(false, '2026-10-29', '2026-10-29', true), false);
});

test('a fresh payload timestamp does not hide an old source tick', () => {
  assert.equal(isSourceFresh(80, 0, 75_000), false);
  assert.equal(isSourceFresh(40, 36_000, 75_000), false);
  assert.equal(isSourceFresh(20, 10_000, 75_000), true);
});

test('missing or invalid source ages are never treated as fresh', () => {
  assert.equal(isSourceFresh(null, 0, 75_000), false);
  assert.equal(isSourceFresh(Number.NaN, 0, 75_000), false);
  assert.equal(isSourceFresh(1, Number.POSITIVE_INFINITY, 75_000), false);
  assert.equal(isSourceFresh(-1, 0, 75_000), false);
});

test('replay status takes precedence over live connection state', () => {
  assert.equal(resolveLiveStatus({
    liveMode: false,
    marketOpen: true,
    connected: true,
    hasLiveData: true,
    hasFreshMarketSources: true,
    hasError: false,
  }), 'REPLAY');
});

test('a connected WebSocket with a measured stale source is never labelled live', () => {
  assert.equal(resolveLiveStatus({
    liveMode: true,
    marketOpen: true,
    connected: true,
    hasLiveData: true,
    hasFreshMarketSources: false,
    hasStaleMarketSources: true,
    hasUnknownMarketSources: false,
    hasError: false,
  }), 'STALE');
});

test('missing feed is distinct from a stale feed', () => {
  const common = { liveMode: true, marketOpen: true, hasFreshMarketSources: false, hasError: false };
  assert.equal(resolveLiveStatus({ ...common, connected: false, hasLiveData: false }), 'NO FEED');
  assert.equal(resolveLiveStatus({ ...common, connected: true, hasLiveData: false }), 'NO FEED');
});

test('market closed is not reported as live or stale', () => {
  assert.equal(resolveLiveStatus({
    liveMode: true,
    marketOpen: false,
    connected: true,
    hasLiveData: true,
    hasFreshMarketSources: false,
    hasError: false,
  }), 'CLOSED');
});


test('missing source-age telemetry is unverified, not falsely stale', () => {
  assert.equal(resolveLiveStatus({
    liveMode: true,
    marketOpen: true,
    connected: true,
    hasLiveData: true,
    hasFreshMarketSources: false,
    hasStaleMarketSources: false,
    hasUnknownMarketSources: true,
    hasError: false,
  }), 'UNVERIFIED');
});

test('a measured old source remains stale even when another source age is unknown', () => {
  assert.equal(resolveLiveStatus({
    liveMode: true,
    marketOpen: true,
    connected: true,
    hasLiveData: true,
    hasFreshMarketSources: false,
    hasStaleMarketSources: true,
    hasUnknownMarketSources: true,
    hasError: false,
  }), 'STALE');
});
