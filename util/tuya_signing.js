// Tuya's canonical URL is sorted and decoded, while the HTTP URL stays encoded.
// Reference: tuya/tuya-connector-nodejs src/core/client.ts, getSignHeaders().
function encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function requestUrl(path, params) {
  const separator = path.indexOf('?');
  const pathname = separator < 0 ? path : path.slice(0, separator);
  const query = {
    ...params,
    ...Object.fromEntries(new URLSearchParams(separator < 0 ? '' : path.slice(separator + 1))),
  };
  const encoded = Object.keys(query).sort()
    .filter(key => query[key] !== null && query[key] !== undefined)
    .map(key => `${encode(key)}=${encode(query[key])}`).join('&');
  return encoded ? `${pathname}?${encoded}` : pathname;
}

function signingUrl(path, params) {
  // Decode exactly once: a literal value "%2C" must stay "%2C", not become ",".
  return decodeURIComponent(requestUrl(path, params));
}

function operationName(path, method = '') {
  const pathname = path.split('?')[0];
  if (String(method).toUpperCase() === 'POST'
    && /^\/v1\.0\/(?:iot-03\/)?devices\/[^/]+\/commands$/.test(pathname)) return 'device command';
  if (pathname === '/v1.0/iot-01/associated-users/actions/authorized-login'
    || pathname === '/v1.0/iot-03/users/login') return 'account login';
  if (/^\/v1\.0\/token(?:\/|$)/.test(pathname)) return 'access token refresh';
  if (pathname === '/v1.0/iot-01/associated-users/devices') return 'associated device list';
  if (pathname === '/v1.0/iot-03/users/assets') return 'asset list';
  if (/^\/v1\.0\/iot-02\/assets\/[^/]+\/devices$/.test(pathname)) return 'asset device list';
  if (pathname === '/v1.0/devices/functions') return 'batch device functions';
  if (pathname === '/v1.0/devices' || pathname === '/v1.0/iot-03/devices') return 'batch device information';
  if (pathname === '/v1.0/iot-03/devices/status') return 'batch device status';
  if (/^\/v1\.0\/(?:iot-03\/)?devices\/[^/]+\/functions$/.test(pathname)) return 'device functions';
  return 'cloud operation';
}

module.exports = { requestUrl, signingUrl, operationName };
