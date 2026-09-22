import {
  asBoolean, asNumber, asRecord,
  type DeviceSignals, type Signal,
} from '../signals.js';

/*
 * floor-heating-controller: one DS18B20 on the supply pipe and one pump relay, read every five seconds.
 *
 * Overheat gets its own sensor rather than a badge on the temperature, because it is the one state worth
 * an automation: the firmware forces the pump on and refuses a remote stop until it clears.
 */
export function floorHeatingSignals(state: Record<string, unknown>): DeviceSignals {
  const pump = asRecord(state.pump);
  const temp = asRecord(state.temp);

  const sensorFailed = asBoolean(temp.sensor_failed) === true;
  const age = asNumber(temp.age_s);
  const stale = age === null || age < 0 || age > 60;

  const signals: Signal[] = [
    {
      kind: 'temperature',
      key: 'supply',
      name: 'Floor heating supply',
      celsius: sensorFailed || stale ? null : asNumber(temp.c),
      fault: (asNumber(temp.failures) ?? 0) > 0 && !sensorFailed,
    },
    {
      kind: 'contact',
      key: 'pump',
      name: 'Floor heating pump',
      /* control_alive false means the control task has stopped reporting; the relay state we hold is
       * then just the last thing we heard, so say nothing rather than something stale. */
      open: asBoolean(pump.control_alive) === false ? null : asBoolean(pump.on),
    },
    {
      kind: 'contact',
      key: 'overheat',
      name: 'Floor heating overheat',
      open: asBoolean(temp.overheat),
    },
  ];

  return { model: 'floor-heating-controller', displayName: 'Floor heating', signals };
}
