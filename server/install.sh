#!/bin/sh
# Adds the Apple Home bridge users to the shared Mosquitto broker on hc-data (broker.lan).
# Run as root on the broker. Usage: MQTT_FH_PASS=... MQTT_GATE_PASS=... MQTT_HOMEBRIDGE_PASS=... ./install.sh
#
# Mosquitto takes one password_file and one acl_file, so every project writes a fragment into
# passwd.d/acl.d and the whole set is concatenated. Never edit /etc/mosquitto/passwd or
# /etc/mosquitto/acl directly: the next heating or water deploy would overwrite the result.
set -eu
: "${MQTT_FH_PASS:?set MQTT_FH_PASS}"
: "${MQTT_GATE_PASS:?set MQTT_GATE_PASS}"
: "${MQTT_HOMEBRIDGE_PASS:?set MQTT_HOMEBRIDGE_PASS}"
cd "$(dirname "$0")"

install -d -m 750 -o root -g mosquitto /etc/mosquitto/passwd.d /etc/mosquitto/acl.d
install -m 640 -o root -g mosquitto mosquitto/homekit.acl /etc/mosquitto/acl.d/homekit.acl

PASSWD_TMP=$(mktemp)
mosquitto_passwd -c -b "$PASSWD_TMP" floor-heating-controller "$MQTT_FH_PASS"
mosquitto_passwd -b "$PASSWD_TMP" gate-controller "$MQTT_GATE_PASS"
mosquitto_passwd -b "$PASSWD_TMP" homebridge "$MQTT_HOMEBRIDGE_PASS"
install -m 640 -o root -g mosquitto "$PASSWD_TMP" /etc/mosquitto/passwd.d/homekit
rm -f "$PASSWD_TMP"

cat /etc/mosquitto/passwd.d/* > /etc/mosquitto/passwd.new
cat /etc/mosquitto/acl.d/*.acl > /etc/mosquitto/acl.new
chown root:mosquitto /etc/mosquitto/passwd.new /etc/mosquitto/acl.new
chmod 640 /etc/mosquitto/passwd.new /etc/mosquitto/acl.new
mv /etc/mosquitto/passwd.new /etc/mosquitto/passwd
mv /etc/mosquitto/acl.new /etc/mosquitto/acl

# Reload, not restart: the heating and water devices stay connected.
systemctl reload mosquitto
echo "done"
