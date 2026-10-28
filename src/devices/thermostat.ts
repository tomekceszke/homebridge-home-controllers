import { asBoolean, asNumber, asRecord, asString } from '../signals.js';

/*
 * heatronic-controller's thermostat view (retained heatronic/<mac>/thermostat, heatronic DATA.md "Thermostat
 * view") and the requests a panel may send back (heatronic/room/setpoint/set, DATA.md "Room set point"). The
 * board owns the set point: Apple Home only shows what is in force and asks for a change, like the W100.
 */

export const REQUEST_TOPIC = 'heatronic/room/setpoint/set';
export const REQUEST_SOURCE = 'apple';

/* The board takes a panel's set point in 0.5 °C steps within 10–25 °C (CTL_OVERRIDE_MIN/MAX_X10). The display
 * range starts lower because the frost level (8 °C by default) is a set point in force too. */
export const REQUEST_MIN_C = 10;
export const REQUEST_MAX_C = 25;
export const DISPLAY_MIN_C = 5;

export interface ThermostatView {
  /** The board's own time of the document (ms); null when missing. */
  tsMs: number | null;
  /** The room that controls the heating (the W100 in the living room); null when the board has no reading. */
  roomC: number | null;
  /** The set point in force; the frost level while paused. */
  setC: number | null;
  /** mode "pause": no heating until the next program switch. Apple Home shows it as Off. */
  paused: boolean;
  /** The boiler has a heating request (a pause between burner runs counts). */
  heating: boolean;
  /** The board's own control is on, so a request applies; false while the FW100 controls. */
  acceptsRequests: boolean;
}

/** null when the document is not one: the bridge then keeps what it had and lets it go stale. */
export function thermostatView(value: unknown): ThermostatView | null {
  const doc = asRecord(value);
  if (!('set_c' in doc) && !('room_c' in doc)) {
    return null;
  }
  const ts = asNumber(doc.ts);
  return {
    tsMs: ts === null ? null : ts * 1000,
    roomC: asNumber(doc.room_c),
    setC: asNumber(doc.set_c),
    paused: asString(doc.mode) === 'pause',
    heating: asString(doc.state) === 'heat',
    acceptsRequests: asBoolean(doc.accepts_requests) === true,
  };
}

/** The board's own rounding (0.5 °C), so the value shown while the request is on its way is the one it applies. */
export function requestedSetPoint(celsius: number): number {
  return Math.min(REQUEST_MAX_C, Math.max(REQUEST_MIN_C, Math.round(celsius * 2) / 2));
}

/*
 * When the document was current. A retained copy outlives its board, so after a bridge restart the receipt time
 * alone would make a dead board's last document look fresh; the board's own timestamp is used unless it is
 * missing or ahead of this clock (then the receipt time).
 */
export function documentTime(view: ThermostatView, receivedMs: number): number {
  return view.tsMs !== null && view.tsMs <= receivedMs + 60_000 ? Math.min(view.tsMs, receivedMs) : receivedMs;
}

export type ThermostatRequest = { setC: number } | { mode: 'pause' | 'auto' };

export function requestPayload(request: ThermostatRequest, nowMs: number): string {
  const body = 'setC' in request ? { set_c: request.setC } : { mode: request.mode };
  return JSON.stringify({ ts: Math.floor(nowMs / 1000), ...body, source: REQUEST_SOURCE });
}
