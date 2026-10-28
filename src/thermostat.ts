import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  DISPLAY_MIN_C, REQUEST_MAX_C, requestedSetPoint, type ThermostatRequest, type ThermostatView,
} from './devices/thermostat.js';
import type { HomeControllersPlatform } from './platform.js';

/* How long a requested value is shown before the board's own document wins again. heatronic 0.16.0+ confirms
 * within a second or two; the wall panel waits as long (its confirm timeout). */
const CONFIRM_MS = 35_000;

interface Pending<T> {
  value: T;
  until: number;
}

/*
 * The house thermostat: heatronic-controller's room set point and pause, as one HomeKit Thermostat. Unlike the
 * sensors it writes: every change goes out as a panel request (source "apple") and the board decides; what is
 * shown is always the board's thermostat document, except for a short wait for a request to be confirmed.
 *
 *   Heat = the program (mode auto), Off = pause (no heating until the next program switch, frost kept)
 */
export class ThermostatAccessory {
  private readonly service: Service;
  private view: ThermostatView | null = null;
  private reachable = false;
  private pendingSet: Pending<number> | null = null;
  private pendingPaused: Pending<boolean> | null = null;
  private expiry?: NodeJS.Timeout;

  constructor(
    private readonly platform: HomeControllersPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly name: string,
    serial: string,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Tomek Ceszke')
      .setCharacteristic(Characteristic.Model, 'heatronic-controller')
      .setCharacteristic(Characteristic.SerialNumber, serial);

    this.service = this.accessory.getService(Service.Thermostat) ?? this.accessory.addService(Service.Thermostat);
    this.service.setCharacteristic(Characteristic.Name, name);

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.read(() => this.view?.roomC ?? null));

    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: DISPLAY_MIN_C, maxValue: REQUEST_MAX_C, minStep: 0.5 })
      .onGet(() => this.read(() => this.setPoint()))
      .onSet((value) => this.setTarget(value));

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({ validValues: [
        Characteristic.CurrentHeatingCoolingState.OFF, Characteristic.CurrentHeatingCoolingState.HEAT,
      ] })
      .onGet(() => this.read(() => this.currentState()));

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [
        Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT,
      ] })
      .onGet(() => this.read(() => this.targetState()))
      .onSet((value) => this.setMode(value));

    /* Apple Home converts for display itself; the board works in Celsius. */
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => undefined);
  }

  update(view: ThermostatView, reachable: boolean): void {
    this.view = view;
    this.reachable = reachable;
    /* The board's document confirms a request once it shows it; until then the request stays on screen. */
    if (this.pendingSet !== null && view.setC === this.pendingSet.value) {
      this.pendingSet = null;
    }
    if (this.pendingPaused !== null && view.paused === this.pendingPaused.value) {
      this.pendingPaused = null;
    }
    this.push();
  }

  setReachable(reachable: boolean): void {
    if (reachable !== this.reachable) {
      this.reachable = reachable;
      this.push();
    }
  }

  private paused(): boolean | null {
    return this.live(this.pendingPaused) ?? this.view?.paused ?? null;
  }

  private setPoint(): number | null {
    return this.live(this.pendingSet) ?? this.view?.setC ?? null;
  }

  private live<T>(pending: Pending<T> | null): T | null {
    return pending !== null && Date.now() < pending.until ? pending.value : null;
  }

  private targetState(): number | null {
    const paused = this.paused();
    if (paused === null) {
      return null;
    }
    const { TargetHeatingCoolingState } = this.platform.Characteristic;
    return paused ? TargetHeatingCoolingState.OFF : TargetHeatingCoolingState.HEAT;
  }

  private currentState(): number | null {
    if (this.view === null) {
      return null;
    }
    const { CurrentHeatingCoolingState } = this.platform.Characteristic;
    return this.view.heating ? CurrentHeatingCoolingState.HEAT : CurrentHeatingCoolingState.OFF;
  }

  private async setTarget(value: CharacteristicValue): Promise<void> {
    const setC = requestedSetPoint(Number(value));
    await this.request({ setC });
    this.pendingSet = { value: setC, until: Date.now() + CONFIRM_MS };
    this.scheduleExpiry();
    if (setC !== Number(value)) {
      this.push();
    }
  }

  private async setMode(value: CharacteristicValue): Promise<void> {
    const pause = value === this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    /* The Home app sends Heat again along with a temperature change. "auto" also ends a panel's set point, so it
     * goes out only to end a pause. */
    if (pause === this.paused()) {
      return;
    }
    await this.request({ mode: pause ? 'pause' : 'auto' });
    this.pendingPaused = { value: pause, until: Date.now() + CONFIRM_MS };
    this.scheduleExpiry();
  }

  private async request(request: ThermostatRequest): Promise<void> {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    if (!this.reachable || this.view === null) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.view.acceptsRequests) {
      this.platform.log.warn(`${this.name}: the board does not take requests now (the FW100 controls); refused`);
      throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    try {
      await this.platform.publishRequest(request);
    } catch (error) {
      this.platform.log.warn(`${this.name}: request not sent (${(error as Error).message})`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** When a request was never confirmed, Apple Home goes back to what the board shows. */
  private scheduleExpiry(): void {
    if (this.expiry) {
      clearTimeout(this.expiry);
    }
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      if (this.pendingSet !== null || this.pendingPaused !== null) {
        this.platform.log.warn(`${this.name}: request not confirmed by the board within ${CONFIRM_MS / 1000} s`);
        this.pendingSet = null;
        this.pendingPaused = null;
        this.push();
      }
    }, CONFIRM_MS + 100);
    this.expiry.unref();
  }

  /* Same rule as the sensors: unknown is "No Response", never a remembered or default value. */
  private read(get: () => CharacteristicValue | null): CharacteristicValue {
    const value = this.reachable ? get() : null;
    if (value === null) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  private push(): void {
    const { Characteristic } = this.platform;
    const values: [Parameters<Service['updateCharacteristic']>[0], CharacteristicValue | null][] = [
      [Characteristic.CurrentTemperature, this.view?.roomC ?? null],
      [Characteristic.TargetTemperature, this.setPoint()],
      [Characteristic.CurrentHeatingCoolingState, this.currentState()],
      [Characteristic.TargetHeatingCoolingState, this.targetState()],
    ];
    for (const [characteristic, value] of values) {
      if (value === null || !this.reachable) {
        this.service.updateCharacteristic(characteristic,
          new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      } else {
        this.service.updateCharacteristic(characteristic, value);
      }
    }
  }
}
