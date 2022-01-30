'use strict';

const JablotronClient = require('./jablotron-client');

function Jablotron(service) {
    this.service = service;
    this.client = new JablotronClient(service.getLog());
    this.sessionId = null;
}

Jablotron.prototype = {

    fetchSessionId: function (callback) {
        if (this.sessionId != null) {
            callback(this.sessionId);
            return;
        }

        let payload = {
            'login': this.service.username,
            'password': this.service.password,
            'system': 'Android'
        };

        let self = this;
        this.client.doRequest('/login.json', payload, null, function (response) {
            let sessionId = response['session_id'];
            self.sessionId = sessionId;
            callback(sessionId);
        }, function () {
            callback(null);
        });
    },

    getPayload: function () {
        let payload = {
            'data': '[{"filter_data":[{"data_type":"thermometer"}],"service_type":"ja100","service_id":' + this.service.jablotronId + ',"data_group":"serviceData","connect":true, "system":"Android"}]'
        };
        return payload;
    },

    parseResponseData: function (response) {
        let data = response['data'];
        if (data != undefined && data != null) {
            data = data['service_data'];
            if (Array.isArray(data) && data.length > 0) {
                data = data[0]['data'];
                if (Array.isArray(data) && data.length > 0) {
                    return data;
                }
            }
        }

        this.service.log('WARN: Unexpected response: ' + JSON.stringify(response, null, 2));
        return null;
    },

    getThermomethers: function (callback) {
        let self = this;
        let payload = this.getPayload();

        this.fetchSessionId(function (sessionId) {
            if (sessionId && sessionId != null) {
                self.client.doAuthenticatedRequest('/dataUpdate.json', payload, sessionId, function (response) {
                    let responseData = self.parseResponseData(response);
                    if (responseData != null) {
                        let segments = responseData[0]['data']['segments'];
                        callback(segments);
                    }
                }, function (error) {
                    if (self.tryHandleError(error)) {
                        self.getAccessoryState(accessory, callback);
                    }
                });
            }
        });
    },

    tryHandleError: function (error) {
        if (error.message == 'not_logged_in') {
            this.sessionId = null;
            return true;
        } else if (error.message == 'Operation failed') {
            this.service.log("ERROR: USER DOES NOT HAVE SUFFICIENT PERMISSIONS");
            return false;
        } else {
            this.service.log(error);
            return false;
        }
    }
};

module.exports = Jablotron;