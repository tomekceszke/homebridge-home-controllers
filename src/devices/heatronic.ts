import { type DeviceSignals } from '../signals.js';
import { heatingSignals } from './heating.js';

/*
 * heatronic-controller: the boiler's bus monitor, which took over heating-controller-1's DS18B20s (heater supply and
 * return, outdoor). Its state document carries them in heating-controller's shape, so they read the same way; it has
 * no supply/return highlights, and the boiler data itself stays out of Apple Home.
 */
export function heatronicSignals(state: Record<string, unknown>): DeviceSignals {
  return { ...heatingSignals(state, { exposeDeltas: false }), model: 'heatronic-controller' };
}
