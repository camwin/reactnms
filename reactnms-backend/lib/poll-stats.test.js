import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPollStats, nextAverage } from './poll-stats.js';

test('poll averages move and stay capped at 99 samples', () => {
  const first = nextAverage(0, 0, 100);
  const second = nextAverage(first.avg, first.samples, 0);
  assert.equal(second.samples, 2);
  assert.equal(second.avg, 50);
  let avg = 0;
  let samples = 0;
  for (let i = 0; i < 150; i += 1) {
    const next = nextAverage(avg, samples, 10);
    avg = next.avg;
    samples = next.samples;
  }
  assert.equal(samples, 99);
  assert.ok(Math.abs(avg - 10) < 0.01);
});

test('poll stats keep the last and average duration per device and cycle', () => {
  const db = new Database(':memory:');
  const stats = createPollStats(db);
  stats.recordDevice('10.0.0.1', 'core', 100, 1000);
  stats.recordDevice('10.0.0.1', 'core', 300, 2000);
  stats.recordCycle(400, 2000);
  const one = stats.device('10.0.0.1');
  assert.equal(one.lastMs, 300);
  assert.equal(one.avgMs, 200);
  assert.equal(one.lastAt, 2000);
  const summary = stats.summary();
  assert.equal(summary.lastMs, 400);
  assert.equal(summary.devices.length, 1);
  assert.equal(summary.devices[0].hostname, 'core');
  stats.forget('10.0.0.1');
  assert.equal(stats.summary().devices.length, 0);
  assert.equal(stats.device('10.9.9.9').lastMs, null);
});
