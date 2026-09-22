import {
  asBoolean, asNumber, asRecord, asString,
  type DeviceSignals, type Signal,
} from '../signals.js';

export interface HeatingOptions {
  /** Expose the supply-return differences the firmware already computes. */
  exposeDeltas: boolean;
}

/*
 * heating-controller: one board, up to eight DS18B20 on a 1-Wire bus, sampled every sample_period_s.
 *
 * A reading is refused rather than shown when the firmware marks the sensor lost, when the value is null,
 * or when it has not been refreshed for three sample periods. The last case is the one that matters in
 * practice: the board stays online and keeps answering, but a sensor that has silently stopped updating
 * would otherwise show a plausible, frozen temperature forever.
 */
export function heatingSignals(state: Record<string, unknown>, options: HeatingOptions): DeviceSignals {
  const board = asString(state.device) ?? 'Heating';
  const period = asNumber(state.sample_period_s) ?? 60;
  const maxAge = period * 3;
  const signals: Signal[] = [];

  const sensors = Array.isArray(state.sensors) ? state.sensors : [];
  for (const entry of sensors) {
    const sensor = asRecord(entry);
    const id = asString(sensor.id);
    if (id === null) {
      continue;
    }
    const age = asNumber(sensor.age_s);
    const stale = age === null || age < 0 || age > maxAge;
    const lost = asBoolean(sensor.lost) === true;
    const celsius = asNumber(sensor.c);

    signals.push({
      kind: 'temperature',
      key: id,
      name: asString(sensor.label) ?? id,
      celsius: lost || stale ? null : celsius,
      /* Errors without a loss means the bus is flaky but still answering: worth a badge, not a blackout. */
      fault: (asNumber(sensor.errors) ?? 0) > 0 && !lost,
    });
  }

  if (options.exposeDeltas) {
    const highlights = Array.isArray(state.highlights) ? state.highlights : [];
    for (const entry of highlights) {
      const highlight = asRecord(entry);
      /* Only the differences: the plain temperatures here are the same sensors again under another name.
       * HomeKit has no service for a temperature difference, so it rides as a TemperatureSensor - 8 K
       * reads as 8 °C, which is wrong as a unit but makes "delta below 2" usable in an automation. */
      if (asString(highlight.unit) !== 'K') {
        continue;
      }
      const caption = asString(highlight.caption) ?? 'delta';
      const age = asNumber(highlight.age_s);
      signals.push({
        kind: 'temperature',
        key: `delta:${caption}`,
        /* No parentheses: HAP rejects them in a Name and the accessory may then fail to add in Apple Home. */
        name: `${caption} delta`,
        celsius: age === null || age < 0 || age > maxAge ? null : asNumber(highlight.value),
      });
    }
  }

  return { model: 'heating-controller', displayName: board, signals };
}
