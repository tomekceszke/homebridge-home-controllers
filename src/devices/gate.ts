import { asBoolean, asRecord, type DeviceSignals } from '../signals.js';

/*
 * gate-controller: deliberately stateless about the gate. The firmware's own words: "a pulse is a pulse,
 * identical in every state". There is no position or motion sensor, so there is no honest way to offer a
 * GarageDoorOpener, which HomeKit requires to report CurrentDoorState.
 *
 * Until the optocoupler on the warning-lamp output exists, the only thing worth surfacing is whether the
 * camera is alive - and even that is off by default, because an accessory nobody asked for is clutter.
 */
export function gateSignals(state: Record<string, unknown>, exposeCameraHealth: boolean): DeviceSignals {
  const camera = asRecord(state.camera);
  return {
    model: 'gate-controller',
    displayName: 'Gate',
    signals: exposeCameraHealth
      ? [{
        kind: 'contact' as const,
        key: 'camera',
        name: 'Gate camera',
        open: asBoolean(camera.healthy),
      }]
      : [],
  };
}
