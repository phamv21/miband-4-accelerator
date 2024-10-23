(() => {
  // src/constants.js
  var UUIDS = {
    miband1: "0000fee0-0000-1000-8000-00805f9b34fb",
    miband2: "0000fee1-0000-1000-8000-00805f9b34fb",
    alert: "00001802-0000-1000-8000-00805f9b34fb",
    devinfo: "0000180a-0000-1000-8000-00805f9b34fb",
    heartrate: "0000180d-0000-1000-8000-00805f9b34fb",
    notifications: "00001811-0000-1000-8000-00805f9b34fb"
  };
  var CHAR_UUIDS = {
    hz: "00000002-0000-3512-2118-0009af100700",
    sensor: "00000001-0000-3512-2118-0009af100700",
    auth: "00000009-0000-3512-2118-0009af100700",
    alert: "00002a06-0000-1000-8000-00805f9b34fb",
    current_time: "00002a2b-0000-1000-8000-00805f9b34fb",
    serial: "00002a25-0000-1000-8000-00805f9b34fb",
    hrdw_revision: "00002a27-0000-1000-8000-00805f9b34fb",
    revision: "00002a28-0000-1000-8000-00805f9b34fb",
    heartrate_measure: "00002a37-0000-1000-8000-00805f9b34fb",
    heartrate_control: "00002a39-0000-1000-8000-00805f9b34fb",
    notifications: "00002a46-0000-1000-8000-00805f9b34fb",
    age: "00002a80-0000-1000-8000-00805f9b34fb",
    le_params: "0000ff09-0000-1000-8000-00805f9b34fb",
    configuration: "00000003-0000-3512-2118-0009af100700",
    fetch: "00000004-0000-3512-2118-0009af100700",
    activity_data: "00000005-0000-3512-2118-0009af100700",
    battery: "00000006-0000-3512-2118-0009af100700",
    steps: "00000007-0000-3512-2118-0009af100700",
    user_settings: "00000008-0000-3512-2118-0009af100700",
    music_notification: "00000010-0000-3512-2118-0009af100700",
    deviceevent: "00000010-0000-3512-2118-0009af100700",
    chunked_transfer: "00000020-0000-3512-2118-0009af100700"
  };
  var ADVERTISEMENT_SERVICE = 65248;

  // src/miband.js
  function buf2hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), (x) => ("00" + x.toString(16)).slice(-2)).join("");
  }
  var concatBuffers = (buffer1, buffer2) => {
    const out = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
    out.set(new Uint8Array(buffer1), 0);
    out.set(new Uint8Array(buffer2), buffer1.byteLength);
    return out.buffer;
  };
  var MiBand5 = class {
    constructor(authKey) {
      if (!authKey.match(/^[a-zA-Z0-9]{32}$/)) {
        throw new Error("Invalid auth key, must be 32 hex characters such as '94359d5b8b092e1286a43cfb62ee7923'");
      }
      this.authKey = authKey;
      this.services = {};
      this.chars = {};
    }
    async init() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          {
            services: [ADVERTISEMENT_SERVICE]
          }
        ],
        optionalServices: [UUIDS.miband2, UUIDS.heartrate, UUIDS.miband1]
      });
      window.dispatchEvent(new CustomEvent("connected"));
      await device.gatt.disconnect();
      const server = await device.gatt.connect();
      console.log("Connected through gatt");
      this.services.miband1 = await server.getPrimaryService(UUIDS.miband1);
      this.services.miband2 = await server.getPrimaryService(UUIDS.miband2);
      this.services.heartrate = await server.getPrimaryService(UUIDS.heartrate);
      console.log("Services initialized");
      this.chars.auth = await this.services.miband2.getCharacteristic(CHAR_UUIDS.auth);
      this.chars.hrControl = await this.services.heartrate.getCharacteristic(CHAR_UUIDS.heartrate_control);
      this.chars.accel_measure = await this.services.miband1.getCharacteristic(CHAR_UUIDS.hz);
      this.chars.sensor = await this.services.miband1.getCharacteristic(CHAR_UUIDS.sensor);
      this.chars.accel_desc = await this.chars.accel_measure.getDescriptor(10498);
      this.chars.hrMeasure = await this.services.heartrate.getCharacteristic(CHAR_UUIDS.heartrate_measure);
      console.log("Characteristics initialized");
      await this.authenticate();
    }
    async authenticate() {
      await this.startNotifications(this.chars.auth, async (e) => {
        const value = e.target.value.buffer;
        const cmd = buf2hex(value.slice(0, 3));
        if (cmd === "100101") {
          console.log("Set new key OK");
        } else if (cmd === "100201") {
          const number = value.slice(3);
          console.log("Received authentication challenge: ", buf2hex(value.slice(3)));
          const key = aesjs.utils.hex.toBytes(this.authKey);
          const aesCbc = new aesjs.ModeOfOperation.cbc(key);
          const out = aesCbc.encrypt(new Uint8Array(number));
          const cmd2 = concatBuffers(new Uint8Array([3, 0]), out);
          console.log("Sending authentication response");
          await this.chars.auth.writeValue(cmd2);
        } else if (cmd === "100301") {
          await this.onAuthenticated();
        } else if (cmd === "100308") {
          console.log("Received authentication failure");
        } else {
          throw new Error(`Unknown callback, cmd='${cmd}'`);
        }
      });
      await this.chars.auth.writeValue(Uint8Array.from([2, 0]));
    }
    async onAuthenticated() {
      console.log("Authentication successful");
      window.dispatchEvent(new CustomEvent("authenticated"));
      await this.measureHr();
    }
    unpack(buffer, offset) {
      const dataView = new DataView(buffer);
      const value1 = dataView.getInt16(offset, true);
      const value2 = dataView.getInt16(offset + 2, true);
      const value3 = dataView.getInt16(offset + 4, true);
      return [value1, value2, value3];
    }
    async measureHr() {
      console.log("Starting accelerator measurement");
      await this.chars.sensor.writeValue(Uint8Array.from([1, 1, 25]));
      await this.chars.sensor.writeValue(Uint8Array.from([2]));
      await this.startNotifications(this.chars.accel_measure, (e) => {
        if (e.target.value.byteLength >= 20) {
          const dataView = e.target.value;
          let offset = 2;
          let x = dataView.getInt16(offset, true);
          let y = dataView.getInt16(offset + 6, true);
          let z = dataView.getInt16(offset + 12, true);
          window.dispatchEvent(new CustomEvent("accel", {
            detail: {x, y, z}
          }));
        }
      });
      this.hrmTimer = this.hrmTimer || setInterval(() => {
        this.chars.sensor.writeValue(Uint8Array.from([1, 1, 25])).then(() => {
          this.chars.sensor.writeValue(Uint8Array.from([2])).then(() => {
            console.log("ping done");
          });
        });
      }, 59700);
      this.hrmTimer2 = this.hrmTimer2 || setInterval(() => {
        this.chars.sensor.writeValue(Uint8Array.from([1, 1, 25])).then(() => {
          this.chars.sensor.writeValue(Uint8Array.from([2])).then(() => {
            console.log("ping done");
          });
        });
      }, 72700);
    }
    async startNotifications(char, cb) {
      await char.startNotifications();
      char.addEventListener("characteristicvaluechanged", cb);
    }
  };
  window.MiBand5 = MiBand5;
})();
