import type { HAP, WithUUID, Characteristic } from 'homebridge';

/*
 * HomeKit has no service for water flow, so the numbers ride as Eve's published custom characteristics.
 * Apple Home ignores what it does not recognise and still shows the contact sensor; the Eve app shows the
 * flow rate and the daily total, with history.
 *
 * Formats, Perms and Units come off api.hap rather than the Characteristic class: Homebridge 2 removed
 * the latter.
 */

const FLOW_RATE_UUID = 'E863F10B-079E-48FF-8F27-9C2605A29F52';
const WATER_TOTAL_UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

export interface EveCharacteristics {
  FlowRate: WithUUID<new () => Characteristic>;
  WaterTotal: WithUUID<new () => Characteristic>;
}

export function eveCharacteristics(hap: HAP): EveCharacteristics {
  class FlowRate extends hap.Characteristic {
    static readonly UUID = FLOW_RATE_UUID;
    constructor() {
      super('Flow Rate', FLOW_RATE_UUID, {
        format: hap.Formats.UINT16,
        unit: 'l/min',
        minValue: 0,
        maxValue: 10000,
        minStep: 1,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class WaterTotal extends hap.Characteristic {
    static readonly UUID = WATER_TOTAL_UUID;
    constructor() {
      super('Water Total', WATER_TOTAL_UUID, {
        format: hap.Formats.UINT32,
        unit: 'l',
        minValue: 0,
        maxValue: 1000000000,
        minStep: 1,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  return {
    FlowRate: FlowRate as unknown as WithUUID<new () => Characteristic>,
    WaterTotal: WaterTotal as unknown as WithUUID<new () => Characteristic>,
  };
}
