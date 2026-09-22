import { createRequire } from 'node:module';
import type { API, PlatformAccessory } from 'homebridge';

/*
 * Apple Home draws no graphs, for any accessory, ever. The Eve app does - but only for accessories that
 * speak Elgato's history protocol, which fakegato-history implements on our behalf. The samples live in
 * a file on the Homebridge host; nothing is sent anywhere.
 *
 * This is a convenience, not the system of record: the same readings already land in PostgreSQL on
 * hc-data and in each device's own 24 h ring. If it fails to load, the accessories still work.
 */

const require = createRequire(import.meta.url);

type EntryType = 'weather' | 'door';

interface FakeGatoService {
  addEntry(entry: Record<string, number>): void;
}

type FakeGatoConstructor = new (
  type: EntryType,
  accessory: PlatformAccessory,
  options: { storage: string; path?: string; disableTimer?: boolean },
) => FakeGatoService;

export class History {
  private readonly constructorFor: FakeGatoConstructor | null;

  constructor(api: API, private readonly storagePath: string, warn: (message: string) => void) {
    let loaded: FakeGatoConstructor | null = null;
    try {
      loaded = (require('fakegato-history') as (api: API) => FakeGatoConstructor)(api);
    } catch (error) {
      warn(`Eve history unavailable, charts will be missing: ${(error as Error).message}`);
    }
    this.constructorFor = loaded;
  }

  attach(type: EntryType, accessory: PlatformAccessory): FakeGatoService | null {
    if (this.constructorFor === null) {
      return null;
    }
    /* disableTimer: fakegato's own 10-minute filler would invent samples for a sensor that has gone
     * quiet, which is exactly the frozen-reading problem the rest of the plugin avoids. */
    return new this.constructorFor(type, accessory, {
      storage: 'fs',
      path: this.storagePath,
      disableTimer: true,
    });
  }
}

export type { FakeGatoService, EntryType };
