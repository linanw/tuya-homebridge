const axios = require('axios').default;
const Crypto = require('crypto-js');
const { randomUUID } = require('node:crypto');
const LogUtil = require('../util/logutil');
const TuyaSigning = require('../util/tuya_signing');
const nonce = randomUUID();
const REQUEST_TIMEOUT_MS = 15000;

class TuyaOpenAPI {

  constructor(endpoint, accessId, accessKey, log, lang = 'en') {
    this.endpoint = endpoint;
    this.access_id = accessId;
    this.access_key = accessKey;
    this.lang = lang;
    this.log = log || new LogUtil();
    this._refreshPromise = null;
    if (typeof this.log.addSecrets === 'function') this.log.addSecrets(accessId, accessKey);
    
    this.assetIDArr = new Array();
    this.deviceArr = new Array();

    this.tokenInfo = {
      access_token: '',
      refresh_token: '',
      uid: '',
      expire: 0,
    }
  }

  async _refreshAccessTokenIfNeed(path) {
    if (path.startsWith('/v1.0/token') || !this.isLogin()) return;
    if (this._refreshPromise) return this._refreshPromise;
    if (this.tokenInfo.expire - 60 * 1000 > Date.now()) return;
    this._refreshPromise = (async () => {
      if (!this.tokenInfo.refresh_token) throw new Error('Tuya token refresh is unavailable; sign in again');
      const res = await this.get(`/v1.0/token/${this.tokenInfo.refresh_token}`);
      this._saveToken(res.result);
    })();
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async login(username, password) {
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      throw new Error('Tuya account username and password are required');
    }
    if (typeof this.log.addSecrets === 'function') {
      this.log.addSecrets(username, password, Crypto.SHA256(password).toString().toLowerCase());
    }
    let res = await this.post('/v1.0/iot-03/users/login', {
      'username': username,
      'password': Crypto.SHA256(password).toString().toLowerCase(),
    });
    this._saveToken(res.result);
    return res.result;
  }

  _saveToken(result) {
    if (!result || typeof result.access_token !== 'string' || !result.access_token) {
      throw new Error('Tuya login response did not contain an access token');
    }
    const lifetime = Number(result.expire ?? result.expire_time);
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error('Tuya login response contained an invalid token lifetime');
    this.tokenInfo = {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      uid: result.uid,
      expire: lifetime * 1000 + Date.now(),
    };
    if (typeof this.log.addSecrets === 'function') this.log.addSecrets(result.access_token, result.refresh_token);
  }

  isLogin() {
    return Boolean(this.tokenInfo && typeof this.tokenInfo.access_token === 'string' && this.tokenInfo.access_token.length > 0);
  }

  //Get all devices
  async getDeviceList() {
    let assets = await this.get_assets();

    var deviceDataArr = [];
    var deviceIdArr = [];
    for (const asset of assets) {
      let res = await this.getDeviceIDList(asset.asset_id);
      deviceDataArr = deviceDataArr.concat(res);
    }

    for (const deviceData of deviceDataArr) {
      deviceIdArr.push(deviceData.device_id);
    };

    let devicesInfoArr = await this.getDeviceListInfo(deviceIdArr);
    let devicesStatusArr = await this.getDeviceListStatus(deviceIdArr);

    let devices = [];
    for (let i = 0; i < devicesInfoArr.length; i++) {
      let functions = await this.getDeviceFunctions(devicesInfoArr[i].id)
      devices.push(Object.assign({}, devicesInfoArr[i], functions,devicesStatusArr.find((j) => j.id == devicesInfoArr[i].id)))
    }
    return devices;
  }

  // Gets a list of human-actionable assets
  async get_assets() {
    let res = await this.get('/v1.0/iot-03/users/assets', {
      'parent_asset_id': null,
      'page_no': 0,
      'page_size': 100,
    });
    return res.result.assets;
  }

  // Query the list of device IDs under the asset
  async getDeviceIDList(assetID) {
    let res = await this.get(`/v1.0/iot-02/assets/${assetID}/devices`);
    return res.result.list;
  }

  // Gets the device instruction set
  async getDeviceFunctions(deviceID) {
    let res = await this.get(`/v1.0/iot-03/devices/${deviceID}/functions`);
    return res.result;
  }

  // Get individual device information
  async getDeviceInfo(deviceID) {
    let res = await this.get(`/v1.0/iot-03/devices/${deviceID}`);
    return res.result;
  }

  // Batch access to device information
  async getDeviceListInfo(devIds = []) {
    if (devIds.length == 0) {
      return [];
    }
    let res = await this.get(`/v1.0/iot-03/devices`, { 'device_ids': devIds.join(',') });
    return res.result.list;
  }

  // Gets the individual device state
  async getDeviceStatus(deviceID) {
    let res = await this.get(`/v1.0/iot-03/devices/${deviceID}/status`);
    return res.result;
  }

  // Batch access to device status
  async getDeviceListStatus(devIds = []) {
    if (devIds.length == 0) {
      return [];
    }
    let res = await this.get(`/v1.0/iot-03/devices/status`, { 'device_ids': devIds.join(',') });
    return res.result;
  }

  async sendCommand(deviceID, params) {
    let res = await this.post(`/v1.0/iot-03/devices/${deviceID}/commands`, params);
    return res.result;
  }

  async request(method, path, params = null, body = null) {
    if (typeof this.access_id !== 'string' || !this.access_id.trim() ||
      typeof this.access_key !== 'string' || !this.access_key.trim() ||
      typeof this.endpoint !== 'string' || !/^https?:\/\//i.test(this.endpoint)) {
      throw new Error('Tuya Access ID, Access Key and API endpoint must be configured before connecting');
    }
    await this._refreshAccessTokenIfNeed(path);

    let now = new Date().getTime();
    let access_token = path.startsWith('/v1.0/token') ? '' : this.tokenInfo.access_token || '';
    let stringToSign = this._getStringToSign(method, path, params, body)
    let headers = {
      't': `${now}`,
      'client_id': this.access_id,
      'nonce': nonce,
      'Signature-Headers': 'client_id',
      'sign': this._getSign(this.access_id, this.access_key, access_token, now, stringToSign),
      'sign_method': 'HMAC-SHA256',
      'access_token': access_token,
      'lang': this.lang,
      'dev_lang': 'javascript',
      'dev_channel': 'homebridge',
      'devVersion': '1.5.0',
      
    };
    this.log.log('TuyaOpenAPI request:', method.toUpperCase());
    let res;
    try {
      res = await axios({
        baseURL: this.endpoint,
        url: TuyaSigning.requestUrl(path, params),
        method: method,
        headers: headers,
        data: body,
        timeout: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(typeof this.log.safeErrorMessage === 'function'
        ? this.log.safeErrorMessage(error) : LogUtil.safeErrorMessage(error));
    }
    if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data) ||
      typeof res.data.success !== 'boolean') throw new Error('Tuya API returned an invalid response');
    if (res.data.success === false) {
      const code = String(res.data.code ?? 'unknown');
      const hint = code === '2001' ? '; Tuya API reports device offline' : '';
      throw new Error(`Tuya API rejected the request (code ${/^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'unknown'}); operation: ${TuyaSigning.operationName(path, method)}${hint}`);
    }
    this.log.log('TuyaOpenAPI response received');
    return res.data;
  }

  async get(path, params) {
    return this.request('get', path, params, null);
  }

  async post(path, params) {
    return this.request('post', path, null, params);
  }
  
  _getSign(access_id, access_key, access_token = '', timestamp = 0, stringToSign) {
    let message = access_id + access_token + `${timestamp}` + nonce + stringToSign;
    let hash = Crypto.HmacSHA256(message, access_key);
    let sign = hash.toString().toUpperCase();
    return sign;
  }

  _getStringToSign(method, path, params, body) {
    let httpMethod = method.toUpperCase();
    let bodyStream
    if (body) {
      bodyStream = JSON.stringify(body)
    }else{
      bodyStream = ''
    }
    
    let contentSHA256 = Crypto.SHA256(bodyStream)
    let headers = 'client_id' + ':' + this.access_id + "\n"
    let url = this._getSignUrl(path, params)
    let result = httpMethod + "\n" + contentSHA256 + "\n" + headers + "\n" + url;
    return result
  }

  _getSignUrl(path, obj) {
    return TuyaSigning.signingUrl(path, obj);
  }

}

module.exports = TuyaOpenAPI;
