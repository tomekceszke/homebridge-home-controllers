import {
  asBoolean, asNumber, asRecord, asString,
  type DeviceSignals, type Signal,
} from '../signals.js';

/** Valve reasons that mean protection acted, rather than a person or a restored state. */
const PROTECTION_REASONS = new Set(['tier0', 'tier1', 'tier2', 'tier3']);   // tier3: learned night limit (3.4.2+)

/** Rules that notify: the Tier 3 learned limits (firmware 3.4+) and the dripping-leak rule. A learned limit that
 * closed the valve at night (3.4.2+, `last_rule_closed`) is a Water leak instead. */
const NOTICE_RULES = new Set(['learned_duration', 'learned_volume', 'night_flows', 'leak']);

/** How long "Unusual water use" stays open after a notice, so Apple Home has time to show it. */
const NOTICE_WINDOW_S = 30 * 60;

/*
 * "Unusual water use" is the warning level, below the leak alarm: the firmware noticed something odd but did not
 * shut the water off. It is open while the running flow is past the learned limit for its hour, or for
 * NOTICE_WINDOW_S after a Tier 2 notice. A contact sensor rather than a second leak sensor, because Apple Home
 * sends leak sensors as critical alerts, and a notice must not wake anyone.
 */
function unusualUse(state: Record<string, unknown>, nowS: number): boolean | null {
  const flow = asRecord(state.flow);
  const tier2 = asRecord(state.tier2);
  const learned = asRecord(state.learned);
  if (Object.keys(tier2).length === 0) {
    return null;
  }
  const limitS = asNumber(learned.limit_s) ?? 0;
  const limitL = asNumber(learned.limit_l) ?? 0;
  const pastLimit = asBoolean(flow.flowing) === true && asBoolean(learned.active) === true
    && ((limitS > 0 && (asNumber(flow.seconds) ?? 0) > limitS) || (limitL > 0 && (asNumber(flow.liters) ?? 0) > limitL));
  const lastAt = asNumber(tier2.last_rule_at) ?? 0;   // 0 while the board's clock is not synced
  const recentNotice = NOTICE_RULES.has(asString(tier2.last_rule) ?? '') && asBoolean(tier2.last_rule_closed) !== true
    && lastAt > 0 && nowS - lastAt < NOTICE_WINDOW_S;
  return pastLimit || recentNotice;
}

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
      key: 'unusual',
      name: 'Unusual water use',
      open: unusualUse(state, Date.now() / 1000),
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
