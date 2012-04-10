/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

Cu.import("resource://services-common/log4moz.js");

/**
 * Represents a token server instance.
 */
function TokenServer() {
  this._log = Log4Moz.repository.getLogger("Services.Common.TokenServer");

  this.server = new nsHttpServer();

  this._pathPrefix = "/1.0";
  this._apps = {};
}
TokenServer.prototype = {
  /**
   * Start the server on a specified port.
   */
  start: function start(port) {
    if (!port) {
      throw new Error("port argument must be specified.");
    }

    this.server.start(port);
  },

  /**
   * Stop the server.
   *
   * Calls the specified callback when the server is stopped.
   */
  stop: function stop(cb) {
    let handler = {
      onStopped: function() { cb(); }
    };

    this.server.stop(handler);
  },

  /**
   * Registers an application for token support.
   */
  registerApp: function registerApplication(name, version, endpoint) {
    let nameVersionPair = name + "/" + version;
    let path = this._pathPrefix + "/" + nameVersionPair;

    this._apps[nameVersionPair] = {
      endpoint: endpoint,
      users:    {},
    };

    this.server.registerPathHandler(path, this._appHandler(nameVersionPair);
  },

  _appHandler: function _appHandler(appKey) {
    let self = this;

    return function(request, response) {
      let method = request.method;
      switch (method) {
        case "GET":
          return self._getTokenHandler(appKey, request, response);

        default:
          response.setHeader("Allow", "GET");
          response.setStatusLine(request.httpVersion, 405,
                                 "Method Not Allowed");
          response.finish();
      }
    };
  },

  _getTokenHandler: function _getTokenHandler(appKey, request, response) {
    if (!(appKey in this._apps)) {
      response.setStatusLine(request.httpVersion, 404, "Not Found");
      let body = "Application not registered.";
      response.bodyOutputStream.write(body, body.length);
      response.finish();
      return;
    }

    // TODO.
  },
};
