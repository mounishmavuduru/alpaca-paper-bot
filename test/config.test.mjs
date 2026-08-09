import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBool, parseNum, parseSymbols, assertDisjoint } from '../lib/config.mjs';

test('parseBool accepts case/space variants, rejects garbage', () => {
  assert.equal(parseBool('X', true, { X: 'false' }), false);
  assert.equal(parseBool('X', true, { X: ' FALSE ' }), false);  // GitHub var UI trailing space
  assert.equal(parseBool('X', false, { X: 'True' }), true);
  assert.equal(parseBool('X', true, {}), true);                 // default
  assert.equal(parseBool('X', true, { X: '' }), true);
  assert.throws(() => parseBool('X', true, { X: 'flase' }), /not a boolean/);
});

test('parseNum validates range and rejects NaN', () => {
  assert.equal(parseNum('X', 5, { env: { X: '15' } }), 15);
  assert.equal(parseNum('X', 5, { env: { X: '15%' } }), 15);    // tolerate a stray %
  assert.equal(parseNum('X', 5, { env: {} }), 5);
  assert.throws(() => parseNum('X', 5, { env: { X: 'abc' } }), /not a number/);
  assert.throws(() => parseNum('X', 5, { min: 0, max: 100, env: { X: '150' } }), /outside/);
});

test('parseSymbols normalizes, validates, dedupes', () => {
  assert.deepEqual(parseSymbols('S', 'SPY,QQQ', {}), ['SPY', 'QQQ']);
  assert.deepEqual(parseSymbols('S', 'x', { S: ' spy , brk.b ' }), ['SPY', 'BRK.B']);
  assert.throws(() => parseSymbols('S', 'x', { S: 'SPY,SPY' }), /duplicates/);
  assert.throws(() => parseSymbols('S', 'x', { S: 'SPY,$$$' }), /invalid symbols/);
  assert.throws(() => parseSymbols('S', 'x', { S: ' , ' }), /empty/);
});

test('assertDisjoint blocks overlapping universes unless overridden', () => {
  assert.throws(() => assertDisjoint('A', ['SPY', 'XLK'], 'B', ['XLK'], {}), /overlap \(XLK\)/);
  assert.deepEqual(assertDisjoint('A', ['SPY'], 'B', ['XLK'], {}), []);
  assert.deepEqual(assertDisjoint('A', ['XLK'], 'B', ['XLK'], { ALLOW_UNIVERSE_OVERLAP: 'true' }), ['XLK']);
});
