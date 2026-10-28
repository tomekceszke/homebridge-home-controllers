import assert from 'node:assert/strict';
import { test } from 'node:test';

import { documentTime, requestedSetPoint, requestPayload, thermostatView } from './thermostat.js';

test('a document under our control', () => {
  assert.deepEqual(thermostatView({
    ts: 1761650000.5, state: 'heat', flame: false, room_c: 21.4, room_source: 'w100', set_c: 21.5, mode: 'day',
    controller: 'heatronic', accepts_requests: true, override: true,
  }), { tsMs: 1761650000500, roomC: 21.4, setC: 21.5, paused: false, heating: true, acceptsRequests: true });
});

test('a pause shows the frost level and Off', () => {
  const view = thermostatView({ state: 'idle', room_c: 20.9, set_c: 8.0, mode: 'pause', accepts_requests: true });
  assert.equal(view?.paused, true);
  assert.equal(view?.setC, 8);
  assert.equal(view?.heating, false);
});

test('stale values are null, the FW100 refuses requests', () => {
  assert.deepEqual(thermostatView({ state: null, room_c: null, set_c: 21.0, mode: 'day' }),
    { tsMs: null, roomC: null, setC: 21, paused: false, heating: false, acceptsRequests: false });
});

test('something else is not a thermostat document', () => {
  assert.equal(thermostatView(null), null);
  assert.equal(thermostatView('online'), null);
  assert.equal(thermostatView({ device: 'Heatronic', sensors: [] }), null);
});

test('set points round to 0.5 within the board range', () => {
  assert.equal(requestedSetPoint(21.3), 21.5);
  assert.equal(requestedSetPoint(21.2), 21);
  assert.equal(requestedSetPoint(8), 10);
  assert.equal(requestedSetPoint(27), 25);
});

test('request payloads', () => {
  assert.deepEqual(JSON.parse(requestPayload({ setC: 21.5 }, 1761650000999)),
    { ts: 1761650000, set_c: 21.5, source: 'apple' });
  assert.deepEqual(JSON.parse(requestPayload({ mode: 'pause' }, 1761650000000)),
    { ts: 1761650000, mode: 'pause', source: 'apple' });
});

test('a retained document is as old as its own timestamp', () => {
  const now = 1761650000000;
  const view = (ts: number | null) => thermostatView({ ts, set_c: 21, room_c: 21 })!;
  assert.equal(documentTime(view(now / 1000 - 3600), now), now - 3600_000);
  assert.equal(documentTime(view(now / 1000 + 10), now), now);          // a few seconds ahead: now
  assert.equal(documentTime(view(now / 1000 + 600), now), now);         // a wrong clock: receipt time
  assert.equal(documentTime(view(null), now), now);
});
