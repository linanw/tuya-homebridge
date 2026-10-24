const axios = require('axios').default;
const Crypto = require('crypto-js');
const { randomUUID } = require('node:crypto');
const LogUtil = require('../util/logutil');
const TuyaSigning = require('../util/tuya_signing');
const nonce = randomUUID();
const REQUEST_TIMEOUT_MS = 15000;
const CountryUtil = require('../util/countryutil')
class TuyaSHOpenAPI {

  constructor(accessId, accessKey, username, password, countryCode, appSchema, log, lang = 'en') {
    this.countryCode = countryCode;
    this.endpoint = (this.countryCode)? new CountryUtil().getEndPointWithCountryCode(this.countryCode) : "https://openapi.tuyaus.com"
    this.access_id = accessId;
    this.access_key = accessKey;
    this.lang = lang;
    this.username = username;
    this.password = password;
    
    this.appSchema = appSchema;
    this.log = log || new LogUtil();
    this._refreshPromise = null;
    if (typeof this.log.addSecrets === 'function') {
      this.log.addSecrets(accessId, accessKey, username, password,
        typeof password === 'string' ? Crypto.MD5(password).toString() : undefined);
    }

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

    if (path.startsWith('/v1.0/iot-01/associated-users/actions/authorized-login')) {
      return;
    }

    if (this._refreshPromise) return this._refreshPromise;
    if (this.tokenInfo.expire - 60 * 1000 > Date.now()) return;
    this._refreshPromise = (async () => {
      const md5pwd = Crypto.MD5(this.password).toString();
      const res = await this.post('/v1.0/iot-01/associated-users/actions/authorized-login', {
        country_code: this.countryCode,
        username: this.username,
        password: md5pwd,
        schema: this.appSchema,
      });
      const result = res.result;
      if (!result || typeof result.access_token !== 'string' || !result.access_token ||
        !Number.isFinite(Number(result.expire_time)) || Number(result.expire_time) <= 0) {
        throw new Error('Tuya login response did not contain a valid access token');
      }
      this.endpoint = result.platform_url || this.endpoint;
      this.tokenInfo = {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        uid: result.uid,
        expire: Number(result.expire_time) * 1000 + Date.now(),
      };
      if (typeof this.log.addSecrets === 'function') this.log.addSecrets(result.access_token, result.refresh_token);
    })();
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  //Gets the list of devices under the associated user
  async getDevices() {
    let res = await this.get(`/v1.0/iot-01/associated-users/devices`, { 'size': 100 });

    let tempIds = [];
    for (let i = 0; i < res.result.devices.length; i++) {
      tempIds.push(res.result.devices[i].id)
    }
    let deviceIds = this._refactoringIdsGroup(tempIds, 20);
    let devicesFunctions = [];
    for (let ids of deviceIds) {
      let functions = await this.getDevicesFunctions(ids);
      devicesFunctions.push.apply(devicesFunctions,functions);
    }
    let devices = [];
    if (devicesFunctions) {
      for (let i = 0; i < res.result.devices.length; i++) {
        devices.push(Object.assign({}, res.result.devices[i], devicesFunctions.find((j) => j.devices[0] == res.result.devices[i].id)))
      }
    } else {
      devices = res.result.devices;
    }

    return devices;
  }

  _refactoringIdsGroup(array, subGroupLength) {
    let index = 0;
    let newArray = [];
    while(index < array.length) {
        newArray.push(array.slice(index, index += subGroupLength));
    }
    return newArray;
}

  // single device gets the instruction set
  async getDeviceFunctions(deviceID) {
    let res = await this.get(`/v1.0/devices/${deviceID}/functions`);
    return res.result;
  }

  // Batch access to device instruction sets
  async getDevicesFunctions(devIds = []) {
    let res = await this.get(`/v1.0/devices/functions`, { 'device_ids': devIds.join(',') });
    return res.result;
  }

  // Get individual device details
  async getDeviceInfo(deviceID) {
    let res = await this.get(`/v1.0/devices/${deviceID}`);
    return res.result;
  }

  // Batch access to device details
  async getDeviceListInfo(devIds = []) {
    if (devIds.length == 0) {
      return [];
    }
    let res = await this.get(`/v1.0/devices`, { 'device_ids': devIds.join(',') });
    return res.result.list;
  }

  // Gets the individual device state
  async getDeviceStatus(deviceID) {
    let res = await this.get(`/v1.0/devices/${deviceID}/status`);
    return res.result;
  }


  // Remove the device based on the device ID
  async removeDevice(deviceID) {
    let res = await this.delete(`/v1.0/devices/${deviceID}`);
    return res.result;
  }

  // sendCommand
  async sendCommand(deviceID, params) {
    let res = await this.post(`/v1.0/devices/${deviceID}/commands`, params);
    return res.result;
  }

  async request(method, path, params = null, body = null) {
    if ([this.access_id, this.access_key, this.username, this.password, this.appSchema]
      .some(value => typeof value !== 'string' || !value.trim()) || !Number.isFinite(Number(this.countryCode)) || Number(this.countryCode) <= 0) {
      throw new Error('Tuya project and account settings must be configured before connecting');
    }
    await this._refreshAccessTokenIfNeed(path);

    let now = new Date().getTime();
    let access_token = path.startsWith('/v1.0/iot-01/associated-users/actions/authorized-login') ? '' : this.tokenInfo.access_token || '';
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

  async delete(path, params) {
    return this.request('delete', path, params, null);
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

module.exports = TuyaSHOpenAPI;
