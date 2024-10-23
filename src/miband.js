import {ADVERTISEMENT_SERVICE, CHAR_UUIDS, UUIDS} from "./constants.js";

function buf2hex(buffer) {
  return Array.prototype.map
    .call(new Uint8Array(buffer), (x) => ("00" + x.toString(16)).slice(-2))
    .join("");
}

const concatBuffers = (buffer1, buffer2) => {
  const out = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  out.set(new Uint8Array(buffer1), 0);
  out.set(new Uint8Array(buffer2), buffer1.byteLength);
  return out.buffer;
};

export class MiBand5 {
  /**
   * @param {String} authKey
   *   Hex representation of the auth key (https://github.com/Freeyourgadget/Gadgetbridge/wiki/Huami-Server-Pairing)
   *   Example: '94359d5b8b092e1286a43cfb62ee7923'
   */
  constructor(authKey) {
    if (!authKey.match(/^[a-zA-Z0-9]{32}$/)) {
      throw new Error(
        "Invalid auth key, must be 32 hex characters such as '94359d5b8b092e1286a43cfb62ee7923'"
      );
    }
    this.authKey = authKey;
    this.services = {};
    this.chars = {};
  }

  async init() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        {
          services: [ADVERTISEMENT_SERVICE],
        },
      ],
      optionalServices: [UUIDS.miband2, UUIDS.heartrate, UUIDS.miband1],
    });
    window.dispatchEvent(new CustomEvent("connected"));
    await device.gatt.disconnect();
    const server = await device.gatt.connect();
    console.log("Connected through gatt");

    this.services.miband1 = await server.getPrimaryService(UUIDS.miband1);
    this.services.miband2 = await server.getPrimaryService(UUIDS.miband2);
    this.services.heartrate = await server.getPrimaryService(UUIDS.heartrate);
    console.log("Services initialized");

    this.chars.auth = await this.services.miband2.getCharacteristic(
      CHAR_UUIDS.auth
    );
    this.chars.hrControl = await this.services.heartrate.getCharacteristic(
      CHAR_UUIDS.heartrate_control
    );
    this.chars.accel_measure = await this.services.miband1.getCharacteristic(
        CHAR_UUIDS.hz
    );
    this.chars.sensor = await this.services.miband1.getCharacteristic(
        CHAR_UUIDS.sensor
    );
    this.chars.accel_desc = await this.chars.accel_measure.getDescriptor(
        0x2902
    );
    this.chars.hrMeasure = await this.services.heartrate.getCharacteristic(
      CHAR_UUIDS.heartrate_measure
    );

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
        const cmd = concatBuffers(new Uint8Array([3, 0]), out);
        console.log("Sending authentication response");
        await this.chars.auth.writeValue(cmd);
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

    const value1 = dataView.getInt16(offset, true);  // true for little-endian
    const value2 = dataView.getInt16(offset + 2, true);
    const value3 = dataView.getInt16(offset + 4, true);

    return [value1, value2, value3];
  }

  async measureHr() {
    console.log("Starting accelerator measurement")

    await this.chars.sensor.writeValue(Uint8Array.from([0x01, 0x01, 0x19]));
    await this.chars.sensor.writeValue(Uint8Array.from([0x02]));

    await this.startNotifications(this.chars.accel_measure, (e) => {
      // console.log("Received value: ", e.target.value);
      if (e.target.value.byteLength >= 20) {
        const dataView = e.target.value;
        let offset = 2
        let x = dataView.getInt16(offset, true);      // Signed 16-bit integer at offset
        let y = dataView.getInt16(offset + 6, true);  // Signed 16-bit integer at offset + 2
        let z = dataView.getInt16(offset + 12, true); // Signed 16-bit integer at offset + 4
        window.dispatchEvent(
            new CustomEvent("accel", {
              detail: {x, y, z},
            })
        );
      }

    });

    // Start pinging HRM
    this.hrmTimer =
      this.hrmTimer ||
      setInterval( () => {
        // Ping the sensor
         this.chars.sensor.writeValue(Uint8Array.from([0x01,0x01,0x19])).then(() => {
           this.chars.sensor.writeValue(Uint8Array.from([0x02])).then(() => {
             console.log("ping done")
           });
         });

      }, 59700);
    this.hrmTimer2 =
        this.hrmTimer2 ||
        setInterval( () => {
          this.chars.sensor.writeValue(Uint8Array.from([0x01,0x01,0x19])).then(() => {
            this.chars.sensor.writeValue(Uint8Array.from([0x02])).then(() => {
              console.log("ping done")
            });
          });
        }, 72700);
  }

  async startNotifications(char, cb) {
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", cb);
  }
}

window.MiBand5 = MiBand5;
