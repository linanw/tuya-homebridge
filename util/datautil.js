class DataUtil {
    constructor() {}
    
    getSubService(status, deviceType) {
        var subTypeArr = []
        for (var map of status || []) {
            if (deviceType === 'wxkg' || deviceType === 'WirelessSwitch') {
                // Keep button channels separate from battery and switch settings.
                if (/^(?:switch(?:_?\d+)?|switch_mode\d+|switch\d+_value)$/.test(map.code)) {
                    if (!subTypeArr.includes(map.code)) subTypeArr.push(map.code)
                }
                continue
            }
            if (map.code.indexOf("switch") != -1) {
                if (typeof map.value === 'boolean') {
                    subTypeArr.push(map.code)
                } 
            }
        }
        return {
            subType: subTypeArr,
        };
    }
}

module.exports = DataUtil;
