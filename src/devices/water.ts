import {
  asBoolean, asNumber, asRecord, asString,
  type DeviceSignals, type Signal,
} from '../signals.js';

/** Valve reasons that mean protection acted, rather than a person or a restored state. */
const PROTECTION_REASONS = new Set(['tier0', 'tier1', 'tier2']);

/*
 * water-controller: a pulse counter on the inlet and a motorised ball valve.
 *
 * The leak sensor is the point of this device in Apple Home. It reports a leak when the valve is shut and
 * the reason is one of the protection tiers, which is the firmware's own judgement that something is
 * wrong - not a guess made here from flow numbers. Apple Home treats LeakSensor as a critical alert, so
 * it notifies even when the phone is silenced.
 */
export function waterSignals(state: Record<string, unknown>): DeviceSignals {
  const valve = asRecord(state.valve);
  const flow = asRecord(state.flow);
  const usage = asRecord(state.usage);

  const valveState = asString(valve.state);
  const valveOpen = valveState === null ? null : valveState === 'open';
  const reason = asString(valve.reason) ?? '';
  const shutByProtection = valveOpen === false && PROTECTION_REASONS.has(reason);

  const signals: Signal[] = [
    {
      kind: 'leak',
      key: 'leak',
      name: 'Water leak',
      leaking: valveOpen === null ? null : shutByProtection,
    },
    {
      kind: 'contact',
      key: 'valve',
      name: 'Water valve',
      open: valveOpen,
    },
    {
      kind: 'flow',
      key: 'flow',
      name: 'Water flow',
      open: asBoolean(flow.flowing),
      litresPerMinute: asNumber(flow.lpm),
      litresToday: asNumber(usage.liters_today),
    },
  ];

  return { model: 'water-controller', displayName: 'Water', signals };
}
