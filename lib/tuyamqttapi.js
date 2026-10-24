const mqtt = require('mqtt');
const Crypto = require('crypto');
const CryptoJS = require('crypto-js');
const LogUtil = require('../util/logutil');
const LINK_ID = Crypto.randomUUID();
const GCM_TAG_LENGTH = 16;
class TuyaOpenMQ {

    constructor(api, type, log) {
        this.type = type;
        this.api = api;
        this.message_listeners = new Set();
        this.client = null;
        this.log = log || new LogUtil();
        this.running = false;
        this._loopPromise = null;
        this._timer = null;
        this._wake = null;
        this.retryDelayMs = 5000;
    }

    start() {
        if (this._loopPromise) return this._loopPromise;
        if (!this.api || typeof this.api.post !== 'function' || !this.api.tokenInfo || !this.api.tokenInfo.uid) {
            this.log.error('TuyaOpenMQ cannot start before a successful Tuya login');
            return Promise.resolve();
        }
        this.running = true;
        this._loopPromise = this._loop_start().catch(error => {
            this.log.error('TuyaOpenMQ background operation failed:', error);
            this.stop();
        }).finally(() => {
            this._loopPromise = null;
        });
        return this._loopPromise;
    }

    stop() {
        this.running = false;
        if (this._wake) this._wake();
        const client = this.client;
        this.client = null;
        if (client) {
            try {
                client.end(true);
            } catch (error) {
                this.log.error('TuyaOpenMQ could not close the connection:', error);
            }
        }
    }

    _wait(delay) {
        if (!this.running) return Promise.resolve();
        return new Promise(resolve => {
            this._wake = () => {
                clearTimeout(this._timer);
                this._timer = null;
                this._wake = null;
                resolve();
            };
            this._timer = setTimeout(this._wake, delay);
            this._timer.unref();
        });
    }

    async _loop_start() {
        let failures = 0;
        while (this.running) {
            let connectingClient;
            try {
                const response = await this._getMQConfig('mqtt');
                // stop() may be called while the HTTPS request is in flight.
                if (!this.running) break;
                const mqConfig = response && response.success !== false && response.result;
                if (!mqConfig || typeof mqConfig.url !== 'string' ||
                    !/^(mqtts?|wss?|ssl|tcp|tls):\/\//i.test(mqConfig.url) ||
                    ['client_id', 'username', 'password'].some(key => typeof mqConfig[key] !== 'string' || !mqConfig[key]) ||
                    !mqConfig.source_topic || typeof mqConfig.source_topic.device !== 'string' ||
                    !Number.isFinite(Number(mqConfig.expire_time)) || Number(mqConfig.expire_time) <= 60) {
                    throw new Error('Tuya returned invalid MQTT connection settings');
                }
                if (typeof this.log.addSecrets === 'function') {
                    this.log.addSecrets(mqConfig.client_id, mqConfig.username, mqConfig.password, mqConfig.url);
                }
                this.deviceTopic = mqConfig.source_topic.device;
                this.log.log('TuyaOpenMQ connecting');
                const client = mqtt.connect(mqConfig.url, {
                    clientId: mqConfig.client_id,
                    username: mqConfig.username,
                    password: mqConfig.password,
                });
                connectingClient = client;
                client.on('connect', () => this._onConnect());
                client.on('error', error => this._onError(error));
                client.on('end', () => this._onEnd());
                client.on('message', (topic, payload) => {
                    if (!this.running || this.client !== client) return;
                    this._onMessage(client, mqConfig, topic, payload).catch(error => {
                        this.log.error('TuyaOpenMQ could not process a message:', error);
                    });
                });
                if (this.client) this.client.end(true);
                this.client = client;
                client.subscribe(this.deviceTopic);
                failures = 0;
                // Renew cloud-issued credentials before their expiry. The wait
                // is cancellable and does not keep Homebridge alive on shutdown.
                await this._wait(Math.max(1000, Math.min(0x7fffffff, (Number(mqConfig.expire_time) - 60) * 1000)));
            } catch (error) {
                if (connectingClient) {
                    if (this.client === connectingClient) this.client = null;
                    try { connectingClient.end(true); } catch { /* Already closed. */ }
                }
                if (!this.running) break;
                this.log.error('TuyaOpenMQ connection setup failed; retrying:', error);
                const delay = Math.min(60000, this.retryDelayMs * Math.pow(2, Math.min(failures++, 4)));
                await this._wait(delay);
            }
        }
    }

    async _getMQConfig(linkType) {
        let res = await this.api.post('/v1.0/iot-03/open-hub/access-config', {
            'uid': this.api.tokenInfo.uid,
            'link_id': LINK_ID,
            'link_type': linkType,
            'topics': 'device',
            'msg_encrypted_version': this.type,
        });
        return res;
    }

    _onConnect() {
        this.log.log('TuyaOpenMQ connected');
    }

    _onError(error) {
        this.log.error('TuyaOpenMQ connection error:', error);
    }

    _onEnd() {
        this.log.log('TuyaOpenMQ connection ended');
    }

    async _onMessage(client, mqConfig, topic, payload) {
        if (topic !== this.deviceTopic) return;
        let data;
        try {
            const message = JSON.parse(payload.toString());
            data = JSON.parse(this.type === '2.0'
                ? this._decodeMQMessage(message.data, mqConfig.password, message.t)
                : this._decodeMQMessage_1_0(message.data, mqConfig.password));
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid MQTT message data');
        } catch (error) {
            // Payloads and decrypted device data can contain account identifiers;
            // report the failure without dumping either the data or crypto error.
            this.log.error('TuyaOpenMQ ignored an invalid or unauthenticated message');
            return;
        }
        this.log.log('TuyaOpenMQ received a device update');
        await Promise.all(Array.from(this.message_listeners, async listener => {
            try {
                await listener(data);
            } catch (error) {
                this.log.error('TuyaOpenMQ device listener failed:', error);
            }
        }));
    }

    // 1.0
    _decodeMQMessage_1_0(b64msg, password) {
        password = password.substring(8, 24);
        let msg = CryptoJS.AES.decrypt(b64msg, CryptoJS.enc.Utf8.parse(password), {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7,
        }).toString(CryptoJS.enc.Utf8);
        return msg;
    }

    _decodeMQMessage(data, password, t) {
        // Base64 decoding generates Buffers
        var tmpbuffer = Buffer.from(data, 'base64');
        var key = password.substring(8, 24).toString('utf8');
        //get iv_length & iv_buffer
        var iv_length = tmpbuffer.readUIntBE(0,4);
        var iv_buffer = tmpbuffer.slice(4, iv_length + 4);
        //Removes the IV bits of the head and 16 bits of the tail tags
        var data_buffer = tmpbuffer.slice(iv_length + 4, tmpbuffer.length - GCM_TAG_LENGTH);
        var cipher = Crypto.createDecipheriv('aes-128-gcm', key, iv_buffer);
        //setAuthTag buffer
        cipher.setAuthTag(tmpbuffer.slice(tmpbuffer.length - GCM_TAG_LENGTH, tmpbuffer.length));
        //setAAD buffer
        const buf = Buffer.allocUnsafe(6);
        buf.writeUIntBE(t, 0, 6);
        cipher.setAAD(buf);
        
        var msg = Buffer.concat([cipher.update(data_buffer), cipher.final()]);
        return msg.toString('utf8');
    }

    addMessageListener(listener) {
        this.message_listeners.add(listener);
    }

    removeMessageListener(listener) {
        this.message_listeners.delete(listener);
    }

}

module.exports = TuyaOpenMQ;
