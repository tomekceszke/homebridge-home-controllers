# homebridge-home-controllers

Brings the house ESP32 controllers into Apple Home. It subscribes to the shared Mosquitto broker on
`hc-data` and reads nothing else: no device is polled, and the plugin holds no credentials that could
change anything.

## How it works

Every controller publishes a **retained** state document to `<namespace>/<mac>/state` — the same JSON its
own `/admin/status` route serves — plus a retained `status` topic carrying `online`/`offline` that doubles
as the MQTT last will.

Because the state is retained, a subscriber that has just connected receives the full description of every
board within a second or two. Restarting Homebridge therefore costs nothing: there is no discovery round,
no polling interval to wait out, and no window where accessories show stale values.

```
heating/aabbcc000001/state        hc-1, 3 sensors
heating/aabbcc000002/state        hc-2, 7 sensors
water/aabbcc000003/state          valve, flow, usage
floorheating/aabbcc000004/state   supply temperature, pump
gate/aabbcc000005/state           pulse counter, camera health
```

## What appears in Apple Home

| Controller | Accessories |
|---|---|
| heating ×2 | One `TemperatureSensor` per DS18B20, named from the firmware's own labels, plus the supply/return differences if enabled |
| water | `LeakSensor`, a `ContactSensor` for the valve, and a `ContactSensor` for flow carrying the Eve flow-rate and daily-total characteristics |
| floor heating | `TemperatureSensor` for the supply pipe, `ContactSensor` for the pump, `ContactSensor` for overheat |
| gate | Optional `ContactSensor` for camera health |

### Why the gate has no door

The firmware is deliberate about this: *"a pulse is a pulse, identical in every state"*. There is no
position or motion sensor, and HomeKit's `GarageDoorOpener` requires `CurrentDoorState`. Offering one
would mean inventing a state the hardware does not know. An optocoupler on the warning-lamp output would
fix that properly.

### Why a temperature difference shows as °C

HomeKit has no service for a difference. An 8 K delta is published as 8 °C — wrong as a unit, but it makes
"notify me when the supply/return difference collapses" expressible as an ordinary automation. Turn it off
with `exposeHeatingDeltas` if the wrong unit bothers you more than the missing automation.

## Choosing what appears

Ten temperature sensors is a lot of tiles for a house that cares about two of them. `include` is an
allowlist of accessory names, or full ids when two boards label a sensor the same way:

```json
"include": ["Outdoor", "Heater supply", "Water leak", "Water valve", "Water flow", "Floor heating pump"]
```

Anything already in Apple Home and not on the list is **unregistered on the next restart**. That decision
is made from the config alone, before the broker is even contacted: waiting for a device to report in
would leave a removed accessory lingering until its board happened to be online, and would wipe out
everything belonging to a board that was switched off.

`exclude` does the opposite and is ignored when `include` is set.

## Charts

Apple Home draws no graphs, for any accessory. The Eve app does, but only for accessories that speak
Elgato's history protocol, so the plugin records temperatures and binary states through
`fakegato-history`. Samples live in a file on the Homebridge host and go nowhere else.

Fakegato's own ten-minute filler is disabled: it would invent samples for a sensor that has gone quiet,
which is exactly the frozen-reading problem the rest of the plugin exists to avoid.

This is a convenience, not the system of record - the same readings already land in PostgreSQL on hc-data
and in each device's own 24 h ring, which its web app charts.

## Availability

An accessory reports **No Response** rather than a number whenever the reading cannot be trusted:

- the firmware marks the sensor lost, or reports `null`
- the reading has not been refreshed for three sample periods
- the board's state document has not arrived for `staleAfterSeconds` (default 300)
- the broker says the board is offline, or the bridge has lost the broker

The stale-document check matters more than the last will. A board that drops off without a clean
disconnect keeps its retained state sitting on the broker looking current, and Mosquitto only fires the
will after roughly 1.5× the device's keepalive — minutes, not seconds.

A DS18B20 reports `-273` when it fails. Substituting a default, or passing that through, is how a bridge
starts lying: a frozen reading looks exactly like a working one.

## Ghost devices

A board that has only ever published a retained `offline` status — a spare that was powered down while its
last will stayed on the broker — is ignored. Accessories are created from state documents, never from
status alone, so a permanently unreachable device never reaches Apple Home.

## Broker account

The plugin needs a **read-only** account. Device accounts will not work: they are write-only, so
subscribing with one returns the retained status topics and nothing else. `server/install.sh` provisions
`homebridge` along with the two device accounts that exist only for this integration.

Mosquitto takes a single `password_file` and `acl_file`, so every project installs a fragment under
`passwd.d`/`acl.d` and the set is concatenated. Never edit the merged files: the next heating or water
deploy overwrites them.

**Every writable topic is listed explicitly in the ACL, and Mosquitto silently drops publishes no rule
covers** — the device sees a clean PUBACK and a draining outbox while nothing lands. Adding a topic to
firmware means adding an ACL line in the same change.

## Configuration

```json
{
  "platform": "HomeControllers",
  "name": "Home Controllers",
  "broker": {
    "host": "broker.lan",
    "port": 1883,
    "username": "homebridge",
    "password": "…"
  },
  "exposeHeatingDeltas": true,
  "exposeGateCameraHealth": false,
  "staleAfterSeconds": 300
}
```

## Development

```sh
npm install
npm run build
homebridge -D -U ./test-config -P .
```

Requires Node 22 or 24 and Homebridge 1.6+ or 2.x. The plugin is ESM and uses only the public Homebridge
API, so it runs unchanged on both.

## Read-only by design

The plugin never writes to the bus and never calls a device. Control — the valve, the pump, the gate —
is deliberately out of scope for this version: the bridge has to prove it is stable before anything in
Apple Home is allowed to move water or open a gate.
