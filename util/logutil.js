class LogUtil {
    constructor(isDebug = false, logger = console) {
        this.isDebug = isDebug;
        this.logger = logger;
        this.secrets = new Set();
    }

    addSecrets(...values) {
        for (const value of values.flat()) {
            if (typeof value === 'string' && value.length > 0) this.secrets.add(value);
        }
        return this;
    }

    static redact(value) {
        return String(value)
            .replace(/((?:https?|mqtts?|wss?|ssl|tcp|tls):\/\/)([^\s/?#]+)/gi, (url, scheme, authority) => {
                const separator = authority.lastIndexOf('@');
                return separator === -1 ? url : `${scheme}[redacted]@${authority.slice(separator + 1)}`;
            })
            .replace(/\b(Bearer|Basic)\s+[^\s,;"'}]+/gi, '$1 [redacted]')
            .replace(/(["']?(?:password|username|access[_-]?(?:id|key|token)|refresh[_-]?token|client[_-]?id|token|authorization|secret|sign)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[redacted]');
    }

    static safeErrorMessage(error) {
        // Axios errors carry the full request configuration, including signed
        // headers and login data. Never render their object, stack or URL.
        if (error && (error.isAxiosError || error.config || error.request || error.response)) {
            const status = error.response && error.response.status;
            if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP request failed (status ${status})`;
            const code = typeof error.code === 'string' && /^[A-Z_]{2,40}$/.test(error.code) ? error.code : '';
            return code ? `Network request failed (${code})` : 'Network request failed';
        }
        return LogUtil.redact(error && typeof error.message === 'string' ? error.message :
            typeof error === 'string' ? error : 'Unknown error');
    }

    safeErrorMessage(error) {
        return this.sanitize(LogUtil.safeErrorMessage(error));
    }

    sanitize(value, seen = new Set()) {
        if (value instanceof Error) return this.safeErrorMessage(value);
        if (typeof value === 'string') {
            let result = value;
            for (const secret of Array.from(this.secrets).sort((a, b) => b.length - a.length)) {
                result = result.split(secret).join('[redacted]');
            }
            return LogUtil.redact(result);
        }
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        if (Array.isArray(value)) return value.map(item => this.sanitize(item, seen));
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
            /password|username|access[_-]?(id|key|token)|refresh[_-]?token|client[_-]?id|token|authorization|secret|^sign$|headers|config|request/i.test(key)
                ? '[redacted]' : this.sanitize(item, seen)]));
    }

    emit(level, args) {
        const safe = args.map(value => this.sanitize(value));
        if (this.logger && typeof this.logger[level] === 'function') this.logger[level](...safe);
        else if (typeof this.logger === 'function') this.logger(...safe);
        else console[level === 'error' ? 'error' : 'log'](...safe);
    }

    log(...args) {
        if (this.isDebug) this.emit('debug', args);
    }

    error(...args) {
        this.emit('error', args);
    }
}

module.exports = LogUtil;
