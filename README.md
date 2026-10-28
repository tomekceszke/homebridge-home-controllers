# homebridge-home-controllers

Brings the house ESP32 controllers into Apple Home. It subscribes to the shared Mosquitto broker on
`hc-data` and reads nothing else: no device is polled. The one thing it writes is the heating thermostat's
request (set point, pause), on the same topic the wall panels use; the board that owns the heating decides.

## How it works

Every controller publishes a **retained** state document to `<namespace>/<mac>/state` — the same JSON its
own `/admin/status` route serves — plus a retained `status` topic carrying `online`/`offline` that doubles
as the MQTT last will.

Because the state is retained, a subscriber that has just connected receives the full description of every
board within a second or two. Restarting Homebridge therefore costs nothing: there is no discovery round,
no polling interval to wait out, and no window where accessories show stale values.

```
sensors/aabbcc000002/state        sensors-controller, 7 pipe sensors (heating/… before its 2.3.0)
heatronic/aabbcc000006/state      boiler-room and outdoor DS18B20s
heatronic/aabbcc000006/thermostat room temperature, set point and mode in force (the thermostat)
water/aabbcc000003/state          valve, flow, usage
floorheating/aabbcc000004/state   supply temperature, pump
gate/aabbcc000005/state           pulse counter, camera health
```

## What appears in Apple Home

| Controller | Accessories |
|---|---|
| sensors | One `TemperatureSensor` per DS18B20, named from the firmware's own labels, plus the supply/return differences if enabled |
| heatronic | One `TemperatureSensor` per DS18B20, as for sensors, and the house `Thermostat` (below); the rest of the boiler's bus data is not exposed |
| water | `LeakSensor`, a `ContactSensor` "Unusual water use", a `ContactSensor` for the valve, and a `ContactSensor` for flow carrying the Eve flow-rate and daily-total characteristics |
| floor heating | `TemperatureSensor` for the supply pipe, `ContactSensor` for the pump, `ContactSensor` for overheat |
| gate | Optional `ContactSensor` for camera health |

### Two levels for water

The water controller has two levels of trouble, and Apple Home gets both:

- **Water leak** (`LeakSensor`, a critical alert that sounds even on a silenced phone): the valve is shut and the
  reason is a protection tier (Tier 0, 1, 2, or 3 when the learned night shut-off is on). The firmware judged that something is wrong and acted.
- **Unusual water use** (`ContactSensor`, an ordinary notification if enabled for it in Apple Home): the firmware
  noticed something odd but did not shut the water off. It is open while the running flow is past the limit
  learned for its hour (firmware 3.4+ `learned.limit_s` / `limit_l`), and for 30 minutes after a Tier 2 notice
  (a learned limit, too many flows in one night, a dripping leak). It is a contact sensor on purpose: a second leak
  sensor would turn every notice into a critical alert.

Firmware 3.4 republishes the retained state at once on a valve change, a Tier 2 notice or an alert, so both
sensors follow within a second or two instead of at the next 60 s refresh.

### Why the gate has no door

The firmware is deliberate about this: *"a pulse is a pulse, identical in every state"*. There is no
position or motion sensor, and HomeKit's `GarageDoorOpener` requires `CurrentDoorState`. Offering one
would mean inventing a state the hardware does not know. An optocoupler on the warning-lamp output would
fix that properly.

### Why a temperature difference shows as °C

HomeKit has no service for a difference. An 8 K delta is published as 8 °C — wrong as a unit, but it makes
"notify me when the supply/return difference collapses" expressible as an ordinary automation. Turn it off
with `exposeHeatingDeltas` if the wrong unit bothers you more than the missing automation.

## Thermostat

heatronic-controller runs the heating and owns the room set point. Apple Home gets it as one `Thermostat`
(id `heatronic:<mac>:thermostat`, name "Thermostat"), built from the board's retained thermostat document:

| Apple Home | From / to heatronic |
|---|---|
| Current temperature | `room_c`: the reference room that controls the heating (the W100 in the living room) |
| Target temperature | `set_c`, the set point in force; a change sends `{"set_c": 21.5}` (0.5 °C steps, 10–25 °C; the board holds it until the next program switch, at least 2 h) |
| Heat / Off | Heat = the program, Off = `mode: pause` (no heating until the next program switch, frost protection kept); Heat while paused sends `mode: auto` |
| Heating / idle | `state` is `heat` (a heating request, also between burner runs) |

Requests go to `heatronic/room/setpoint/set` with `"source": "apple"`, the contract every panel uses
(heatronic-controller `docs/DATA.md`, Room set point). Apple Home shows the requested value until the board's
document confirms it, at most 35 s, then the document wins and the log says the request was not confirmed. A
PUBACK proves nothing here: the broker drops a publish its ACL does not cover without telling anyone.

Heat is sent again by the Home app along with a temperature change, so `auto` goes out only to end a pause:
it would also end a set point just made.

Writes are refused (an error in the Home app) while the board does not take requests (`accepts_requests`
false: the FW100 controls) and while the broker is down; nothing is queued for later. The thermostat shows
**No Response** when its document is older than 120 s by the board's own timestamp (it comes on every change and
every 30 s, so a retained copy left by a dead board does not count), the board is offline, or the room reading
is missing.

## Choosing what appears

Ten temperature sensors is a lot of tiles for a house that cares about two of them. `include` is an
allowlist of accessory names, or full ids when two boards label a sensor the same way:

```json
"include": ["Outdoor", "Heater supply", "Water leak", "Unusual water use", "Water valve", "Water flow", "Floor heating pump"]
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

The plugin needs a reading account that may also write the one thermostat request topic. Device
accounts will not work: they are write-only, so subscribing with one returns the retained status topics
and nothing else. `server/install.sh` provisions
`homebridge` along with the two device accounts that exist only for this integration.

Mosquitto takes a single `password_file` and `acl_file`, so every project installs a fragment under
`passwd.d`/`acl.d` and the set is concatenated. Never edit the merged files: the next project
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

## One write, by design

The plugin never calls a device. Its only write is the thermostat request (1.4.0), which the heating board
validates and clamps like a request from any wall panel; a leaked bridge password can ask for a set point
or a pause and nothing more. Control of the valve, the pump and the gate stays out of scope: nothing in
Apple Home is allowed to move water or open a gate.
