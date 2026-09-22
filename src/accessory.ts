import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { FakeGatoService } from './history.js';
import type { HomeControllersPlatform } from './platform.js';
import type { Signal } from './signals.js';

/*
 * One accessory per signal. Splitting them this way, rather than stacking every reading of a board onto
 * one accessory, is what lets Apple Home put the outdoor sensor in one room and the heater return in
 * another, and what keeps an automation's trigger list readable.
 */
export class ControllerAccessory {
  private service!: Service;
  private signal: Signal;
  private reachable = false;
  private history: FakeGatoService | null = null;

  constructor(
    private readonly platform: HomeControllersPlatform,
    private readonly accessory: PlatformAccessory,
    signal: Signal,
    model: string,
    serial: string,
  ) {
    this.signal = signal;
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Tomek Ceszke')
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, serial);

    this.buildService();
    this.attachHistory();
  }

  /* Eve charts. Temperatures go in as weather samples, everything binary as door samples - Eve renders
   * those as an on/off timeline, which is what a valve, a pump or a leak alarm actually is. */
  private attachHistory(): void {
    if (!this.platform.history) {
      return;
    }
    this.history = this.platform.history.attach(
      this.signal.kind === 'temperature' ? 'weather' : 'door',
      this.accessory,
    );
  }

  private record(): void {
    if (this.history === null || !this.reachable) {
      return;
    }
    const time = Math.round(Date.now() / 1000);
    if (this.signal.kind === 'temperature') {
      if (this.signal.celsius !== null) {
        this.history.addEntry({ time, temp: this.signal.celsius });
      }
      return;
    }
    const open = this.signal.kind === 'leak'
      ? this.signal.leaking
      : this.signal.open;
    if (open !== null) {
      this.history.addEntry({ time, status: open ? 1 : 0 });
    }
  }

  private buildService(): void {
    const { Service, Characteristic } = this.platform;
    const name = this.signal.name;

    switch (this.signal.kind) {
      case 'temperature': {
        this.service = this.accessory.getService(Service.TemperatureSensor)
          ?? this.accessory.addService(Service.TemperatureSensor);
        this.service.getCharacteristic(Characteristic.CurrentTemperature)
          /* A DS18B20 can legitimately read below zero outdoors, and the HAP default floor is 0. */
          .setProps({ minValue: -55, maxValue: 125 })
          .onGet(() => this.read(() => this.signal.kind === 'temperature' ? this.signal.celsius : null));
        break;
      }
      case 'leak': {
        this.service = this.accessory.getService(Service.LeakSensor)
          ?? this.accessory.addService(Service.LeakSensor);
        this.service.getCharacteristic(Characteristic.LeakDetected)
          .onGet(() => this.read(() => {
            if (this.signal.kind !== 'leak' || this.signal.leaking === null) {
              return null;
            }
            return this.signal.leaking
              ? Characteristic.LeakDetected.LEAK_DETECTED
              : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
          }));
        break;
      }
      case 'contact':
      case 'flow': {
        this.service = this.accessory.getService(Service.ContactSensor)
          ?? this.accessory.addService(Service.ContactSensor);
        this.service.getCharacteristic(Characteristic.ContactSensorState)
          .onGet(() => this.read(() => {
            const open = this.signal.kind === 'contact' || this.signal.kind === 'flow' ? this.signal.open : null;
            if (open === null) {
              return null;
            }
            return open
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED;
          }));
        if (this.signal.kind === 'flow') {
          this.service.getCharacteristic(this.platform.eve.FlowRate);
          this.service.getCharacteristic(this.platform.eve.WaterTotal);
        }
        break;
      }
    }

    /* Name only: ConfiguredName is not part of these services and HAP logs a complaint for every one. */
    this.service.setCharacteristic(Characteristic.Name, name);
  }

  /*
   * Everything unknown becomes SERVICE_COMMUNICATION_FAILURE, which Apple Home renders as "No Response".
   * The alternative - substituting a last known or default value - is what makes a bridge lie: a frozen
   * temperature looks exactly like a working one.
   */
  private read(get: () => CharacteristicValue | null): CharacteristicValue {
    const value = this.reachable ? get() : null;
    if (value === null) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return value;
  }

  /** Re-evaluate availability without a new reading, e.g. when the board's last will fires. */
  setReachable(reachable: boolean): void {
    if (reachable === this.reachable) {
      return;
    }
    this.update(this.signal, reachable);
  }

  update(signal: Signal, reachable: boolean): void {
    this.signal = signal;
    this.reachable = reachable;
    const { Characteristic } = this.platform;

    const push = (characteristic: Parameters<Service['updateCharacteristic']>[0], value: CharacteristicValue | null) => {
      if (value === null || !reachable) {
        this.service.updateCharacteristic(
          characteristic,
          new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          ),
        );
        return;
      }
      this.service.updateCharacteristic(characteristic, value);
    };

    switch (signal.kind) {
      case 'temperature':
        push(Characteristic.CurrentTemperature, signal.celsius);
        this.service.updateCharacteristic(
          Characteristic.StatusFault,
          signal.fault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
        );
        break;
      case 'leak':
        push(Characteristic.LeakDetected, signal.leaking === null
          ? null
          : signal.leaking
            ? Characteristic.LeakDetected.LEAK_DETECTED
            : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
        break;
      case 'contact':
      case 'flow': {
        push(Characteristic.ContactSensorState, signal.open === null
          ? null
          : signal.open
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED);
        if (signal.kind === 'flow') {
          /* Eve's characteristics are integers; the firmware reports fractional litres. */
          if (signal.litresPerMinute !== null) {
            this.service.updateCharacteristic(this.platform.eve.FlowRate, Math.round(signal.litresPerMinute));
          }
          if (signal.litresToday !== null) {
            this.service.updateCharacteristic(this.platform.eve.WaterTotal, Math.round(signal.litresToday));
          }
        }
        break;
      }
    }

    this.record();
  }
}
