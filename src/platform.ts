import mqtt, { type MqttClient } from 'mqtt';
import type {
  API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { ControllerAccessory } from './accessory.js';
import { eveCharacteristics, type EveCharacteristics } from './eve.js';
import { History } from './history.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { asRecord, type DeviceSignals, type Signal } from './signals.js';
import { floorHeatingSignals } from './devices/floorheating.js';
import { gateSignals } from './devices/gate.js';
import { heatingSignals } from './devices/heating.js';
import { heatronicSignals } from './devices/heatronic.js';
import { waterSignals } from './devices/water.js';
import {
  documentTime, REQUEST_TOPIC, requestPayload, thermostatView, type ThermostatRequest,
} from './devices/thermostat.js';
import { ThermostatAccessory } from './thermostat.js';

interface BrokerConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

interface Config extends PlatformConfig {
  broker?: BrokerConfig;
  exposeHeatingDeltas?: boolean;
  exposeGateCameraHealth?: boolean;
  staleAfterSeconds?: number;
  include?: string[];
  exclude?: string[];
}

interface Device {
  namespace: string;
  mac: string;
  online: boolean;
  /** Last value reported to HomeKit, so a transition is logged once rather than every recheck. */
  reachable: boolean;
  lastStateAt: number;
  accessories: Map<string, ControllerAccessory>;
  /** heatronic only: the house thermostat, from its own retained document. */
  thermostat?: ThermostatAccessory;
  lastThermostatAt: number;
}

const RECHECK_INTERVAL_MS = 30_000;
/* heatronic publishes its thermostat document on every change and every 30 s while connected. */
const THERMOSTAT_STALE_MS = 120_000;
const THERMOSTAT_NAME = 'Thermostat';
const PUBLISH_TIMEOUT_MS = 5_000;

/** Debug-log shape: enough to tell a real reading from a refused one at a glance. */
function describeValue(signal: Signal): string {
  switch (signal.kind) {
    case 'temperature':
      return signal.celsius === null ? 'no reading' : `${signal.celsius} °C`;
    case 'leak':
      return signal.leaking === null ? 'no reading' : signal.leaking ? 'LEAK' : 'dry';
    case 'contact':
      return signal.open === null ? 'no reading' : signal.open ? 'open' : 'closed';
    case 'flow':
      return signal.open === null
        ? 'no reading'
        : `${signal.open ? 'flowing' : 'idle'}, ${signal.litresPerMinute ?? '?'} l/min, ${signal.litresToday ?? '?'} l today`;
  }
}

export class HomeControllersPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly eve: EveCharacteristics;
  public readonly history: History;

  private readonly cached: PlatformAccessory[] = [];
  private readonly devices = new Map<string, Device>();
  private client?: MqttClient;
  private recheck?: NodeJS.Timeout;

  constructor(
    public readonly log: Logging,
    public readonly config: Config,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.eve = eveCharacteristics(api.hap);
    this.history = new History(api, api.user.storagePath(), (message) => this.log.warn(message));

    api.on('didFinishLaunching', () => {
      this.pruneUnwanted();
      this.connect();
    });
    api.on('shutdown', () => {
      if (this.recheck) {
        clearInterval(this.recheck);
      }
      this.client?.end(true);
    });
  }

  /** Homebridge replays what it had before restart; the device map is rebuilt as state documents arrive. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  private connect(): void {
    const broker = this.config.broker ?? {};
    if (!broker.host || !broker.username || !broker.password) {
      this.log.error('broker.host, broker.username and broker.password are required; no accessories will appear.');
      return;
    }
    const url = `mqtt://${broker.host}:${broker.port ?? 1883}`;
    this.log.info(`Connecting to ${url} as ${broker.username}`);

    this.client = mqtt.connect(url, {
      username: broker.username,
      password: broker.password,
      /* A fixed client id would fight with another copy of the bridge for the same session. */
      clientId: `homebridge-home-controllers-${this.api.hap.uuid.generate(PLUGIN_NAME).slice(0, 8)}`,
      reconnectPeriod: 10_000,
      clean: true,
    });

    this.client.on('connect', () => {
      this.log.info('Broker connected; subscribing');
      /* The retained state documents arrive immediately on subscribe, so a restart needs no polling and
       * no waiting for the devices' own publish period. */
      this.client!.subscribe(['+/+/state', '+/+/status', 'heatronic/+/thermostat'], { qos: 1 }, (error) => {
        if (error) {
          this.log.error(`Subscribe failed: ${error.message}`);
        }
      });
    });
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    this.client.on('error', (error) => this.log.warn(`Broker error: ${error.message}`));
    this.client.on('close', () => {
      this.log.warn('Broker connection closed; every accessory will report no response until it returns');
      for (const device of this.devices.values()) {
        device.online = false;
      }
      this.refreshAll();
    });

    this.recheck = setInterval(() => this.refreshAll(), RECHECK_INTERVAL_MS);
  }

  private onMessage(topic: string, payload: Buffer): void {
    const [namespace, mac, kind] = topic.split('/');
    if (!namespace || !mac || !kind) {
      return;
    }
    const key = `${namespace}/${mac}`;

    if (kind === 'status') {
      const online = payload.toString() === 'online';
      const device = this.devices.get(key);
      /* A retained "offline" for a board we have never seen a state document from is a ghost: a spare
       * that was powered down while its last will stayed on the broker. Creating accessories for it would
       * put a permanently unreachable device in Apple Home. */
      if (device === undefined) {
        if (online) {
          this.log.debug(`${key} announced itself; waiting for its state document`);
        }
        return;
      }
      device.online = online;
      this.refresh(device);
      return;
    }

    if (kind !== 'state' && !(kind === 'thermostat' && namespace === 'heatronic')) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch (error) {
      this.log.warn(`${topic}: unreadable ${kind} document (${(error as Error).message})`);
      return;
    }

    if (kind === 'thermostat') {
      this.onThermostat(namespace, mac, parsed);
      return;
    }

    const described = this.describe(namespace, asRecord(parsed));
    if (described === null) {
      this.log.debug(`${topic}: no mapping for namespace "${namespace}", ignored`);
      return;
    }

    const device = this.deviceFor(namespace, mac);
    if (device.lastStateAt === 0) {
      this.log.info(`Discovered ${described.displayName} (${namespace}/${mac}), ${described.signals.length} signal(s)`);
    }
    device.lastStateAt = Date.now();
    device.online = true;
    this.sync(device, described);
  }

  /** Created from a document, never from a status alone (see the ghost rule above). */
  private deviceFor(namespace: string, mac: string): Device {
    const key = `${namespace}/${mac}`;
    let device = this.devices.get(key);
    if (device === undefined) {
      device = {
        namespace, mac, online: true, reachable: true, lastStateAt: 0, accessories: new Map(), lastThermostatAt: 0,
      };
      this.devices.set(key, device);
    }
    return device;
  }

  private onThermostat(namespace: string, mac: string, parsed: unknown): void {
    const view = thermostatView(parsed);
    if (view === null) {
      this.log.warn(`${namespace}/${mac}/thermostat: not a thermostat document, ignored`);
      return;
    }
    const id = `${namespace}:${mac}:thermostat`;
    if (!this.allowed(THERMOSTAT_NAME, id)) {
      return;
    }
    const device = this.deviceFor(namespace, mac);
    device.lastThermostatAt = documentTime(view, Date.now());

    if (device.thermostat === undefined) {
      const uuid = this.api.hap.uuid.generate(id);
      let accessory = this.cached.find((entry) => entry.UUID === uuid);
      if (accessory === undefined) {
        accessory = new this.api.platformAccessory(THERMOSTAT_NAME, uuid);
        accessory.context.id = id;
        accessory.context.name = THERMOSTAT_NAME;
        device.thermostat = new ThermostatAccessory(this, accessory, THERMOSTAT_NAME, id);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added "${THERMOSTAT_NAME}"`);
      } else {
        accessory.context.id = id;
        accessory.context.name = THERMOSTAT_NAME;
        device.thermostat = new ThermostatAccessory(this, accessory, THERMOSTAT_NAME, id);
        this.api.updatePlatformAccessories([accessory]);
      }
    }
    device.thermostat.update(view, this.isThermostatReachable(device));
    this.log.debug(`${id} = room ${view.roomC ?? '?'} °C, set ${view.setC ?? '?'} °C${view.paused ? ', paused' : ''}`
      + `${view.acceptsRequests ? '' : ', requests refused'}`);
  }

  /*
   * A panel request on heatronic's contract. Started only over a live connection, so nothing is queued while the
   * broker is down; without a PUBACK within a few seconds the Home app is told it failed.
   */
  async publishRequest(request: ThermostatRequest): Promise<void> {
    const client = this.client;
    if (client === undefined || !client.connected) {
      throw new Error('broker not connected');
    }
    const payload = requestPayload(request, Date.now());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.publishAsync(REQUEST_TOPIC, payload, { qos: 1, retain: false }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('no PUBACK within 5 s')), PUBLISH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.log.info(`${THERMOSTAT_NAME}: requested ${payload}`);
  }

  /*
   * A signal is matched by its name ("Outdoor") or by its full id ("sensors:<mac>:<sensor>"), so the
   * config can stay readable and still disambiguate two boards that label a sensor the same way.
   * An include list, when present, wins outright; otherwise everything not excluded is kept.
   */
  private allowed(name: string, id: string): boolean {
    const matches = (patterns: string[]) => patterns.some((pattern) => {
      const needle = pattern.trim().toLowerCase();
      return needle === name.toLowerCase() || needle === id.toLowerCase();
    });
    const include = this.config.include ?? [];
    if (include.length > 0) {
      return matches(include);
    }
    return !matches(this.config.exclude ?? []);
  }

  /*
   * Config alone decides this, so it runs before the broker is even connected: waiting for a device to
   * report in would leave a removed accessory sitting in Apple Home until its board happened to be
   * online, and would delete everything belonging to a board that was switched off.
   */
  private pruneUnwanted(): void {
    const unwanted = this.cached.filter((accessory) => {
      const id = typeof accessory.context.id === 'string' ? accessory.context.id : accessory.displayName;
      const name = typeof accessory.context.name === 'string' ? accessory.context.name : accessory.displayName;
      return !this.allowed(name, id);
    });
    if (unwanted.length === 0) {
      return;
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unwanted);
    for (const accessory of unwanted) {
      this.log.info(`Removed "${accessory.displayName}" (excluded by config)`);
      const index = this.cached.indexOf(accessory);
      if (index >= 0) {
        this.cached.splice(index, 1);
      }
    }
  }

  private describe(namespace: string, state: Record<string, unknown>): DeviceSignals | null {
    switch (namespace) {
      case 'sensors':   // sensors-controller since 2.3.0
      case 'heating':   // its prefix before 2.3.0, when it was heating-controller
        return heatingSignals(state, { exposeDeltas: this.config.exposeHeatingDeltas !== false });
      case 'heatronic':
        return heatronicSignals(state);
      case 'water':
        return waterSignals(state);
      case 'floorheating':
        return floorHeatingSignals(state);
      case 'gate':
        return gateSignals(state, this.config.exposeGateCameraHealth === true);
      default:
        return null;
    }
  }

  private sync(device: Device, described: DeviceSignals): void {
    const reachable = this.isReachable(device);
    for (const signal of described.signals) {
      const id = `${device.namespace}:${device.mac}:${signal.key}`;
      if (!this.allowed(signal.name, id)) {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(id);
      let handler = device.accessories.get(id);

      if (handler === undefined) {
        const existing = this.cached.find((entry) => entry.UUID === uuid);
        if (existing !== undefined) {
          existing.displayName = signal.name;
          existing.context.id = id;
          existing.context.name = signal.name;
          handler = new ControllerAccessory(this, existing, signal, described.model, id);
          this.api.updatePlatformAccessories([existing]);
        } else {
          const accessory = new this.api.platformAccessory(signal.name, uuid);
          accessory.context.id = id;
          accessory.context.name = signal.name;
          handler = new ControllerAccessory(this, accessory, signal, described.model, id);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.log.info(`Added "${signal.name}"`);
        }
        device.accessories.set(id, handler);
      }
      handler.update(signal, reachable);
      this.log.debug(`${id} = ${describeValue(signal)}${reachable ? '' : ' (unreachable)'}`);
    }
  }

  /*
   * Reachable means the broker says the board is online and its state document is recent. The second
   * condition catches the case the first cannot: a board that dropped off without a clean disconnect, so
   * its last will has not fired yet and the retained state is still sitting there looking current.
   */
  private isReachable(device: Device): boolean {
    const staleAfterMs = (this.config.staleAfterSeconds ?? 300) * 1000;
    return device.online && Date.now() - device.lastStateAt < staleAfterMs;
  }

  /* The thermostat has its own document and a tighter limit: it is the one accessory people act on. */
  private isThermostatReachable(device: Device): boolean {
    return device.online && this.client?.connected === true
      && Date.now() - device.lastThermostatAt < THERMOSTAT_STALE_MS;
  }

  private refresh(device: Device): void {
    const reachable = this.isReachable(device);
    /* A board known so far only from its thermostat document has no state document to go stale. */
    if (reachable !== device.reachable && device.lastStateAt > 0) {
      device.reachable = reachable;
      const reason = device.online ? 'state document went stale' : 'broker reports it offline';
      this.log.info(reachable
        ? `${device.namespace}/${device.mac} is back`
        : `${device.namespace}/${device.mac} stopped responding (${reason})`);
    }
    for (const handler of device.accessories.values()) {
      handler.setReachable(reachable);
    }
    device.thermostat?.setReachable(this.isThermostatReachable(device));
  }

  private refreshAll(): void {
    for (const device of this.devices.values()) {
      this.refresh(device);
    }
  }
}
