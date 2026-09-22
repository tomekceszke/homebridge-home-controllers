/*
 * A signal is one thing Apple Home can show. Each controller's state document is translated into a list of
 * these, and the accessory layer turns them into HomeKit services without knowing which device they came
 * from. Adding a reading to a controller therefore means touching one mapper, not the HomeKit code.
 *
 * A null value means "known to the bridge, but not currently readable" - a lost sensor, a stale document,
 * an offline board. It becomes "No Response" in Apple Home rather than a made-up number, which matters:
 * a DS18B20 reports -273 when it fails and HomeKit would happily display that as a temperature.
 */

export type Signal =
  | TemperatureSignal
  | ContactSignal
  | LeakSignal
  | FlowSignal;

interface SignalBase {
  /** Stable within a device; forms the accessory UUID together with the namespace and MAC. */
  key: string;
  name: string;
}

export interface TemperatureSignal extends SignalBase {
  kind: 'temperature';
  celsius: number | null;
  /** Shown as a fault badge on the accessory, for a sensor that reads but is misbehaving. */
  fault?: boolean;
}

export interface ContactSignal extends SignalBase {
  kind: 'contact';
  /** true renders as "Open" in Apple Home. */
  open: boolean | null;
}

export interface LeakSignal extends SignalBase {
  kind: 'leak';
  leaking: boolean | null;
}

/** A contact sensor that also carries the Eve flow characteristics, which Apple Home has no service for. */
export interface FlowSignal extends SignalBase {
  kind: 'flow';
  open: boolean | null;
  litresPerMinute: number | null;
  litresToday: number | null;
}

/** One physical board and everything it reports. */
export interface DeviceSignals {
  /** Shown in the accessory information block. */
  model: string;
  displayName: string;
  signals: Signal[];
}

/* ---- small defensive accessors: a partial or unexpected document must not take the bridge down ---- */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
