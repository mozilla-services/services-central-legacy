/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

Cu.import("resource://services-common/log4moz.js");

TokenServer10User(uid) {
  this.uid = uid;
  this._assertions = [];
  this._services = {};
}
TokenServer10User.prototype = {
  /**
   * Whether to allow this user to use all services.
   *
   * If true, services will be automatically registered if they don't exist.
   */
  allowAllServices: false,

  /**
   * Determines whether this user has the specified assertion.
   */
  hasAssertion: function hasAssertion(assertion) {
    return this._assertions.indexOf(assertion) != -1;
  },

  /**
   * Associate a valid assertion with this user.
   */
  addAssertion: function addAssertion(assertion) {
    this._assertions.push(assertion);
  },

  getService: function getService(name, version) {
    if (!(name in this._services)) {
      if (!this.allowAllServices) {
        return null;
      }

      this._services[name] = {};
    }

    let service = this._services[name];
    if (!(version in service)) {
      if (!this.allowAllServices) {
        return null;
      }

      service[version] = {tokens: {}};
    }

    return service[version];
  },

  /**
   * Register a service with the user.
   *
   * This allows the user to use a service.
   */
  registerService: function registerService(name, version) {
    if (!(name in this._services)) {
      this._services[name] = {};
    }

    if (!(version in this.services[name])) {
      this._services[name][version] = {tokens: {}};
    }
  },

  /**
   * Register a token for a service with this user.
   *
   * The token is generated elsewhere.
   */
  registerToken: function registerToken(name, version, id, key) {
    let service = this.getService(name, version);
    if (!service) {
      throw new Error("Service not registered with user.");
    }

    service.tokens[id] = key;
  },
};

/**
 * Represents a token server instance.
 */
function TokenServer10Server() {
  this._log = Log4Moz.repository.getLogger("Services.Common.TokenServer");

  this.server = new nsHttpServer();

  this._pathPrefix = "/1.0";
  this._users = {};
  this._apps = {};

  this._tokenCounter = 0;
}
TokenServer10Server.prototype = {
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
   * Registers a user with the server.
   *
   * @return TokenServer10User Newly-created user instance.
   */
  registerUser: function registerUser(uid) {
    if (uid in this._users) {
      throw new Error("User already present.");
    }

    let user = new TokenServer10User(uid);

    this._users[uid] = user;

    return user;
  },

  /**
   * Obtain a reference to a registered application.
   */
  getApp: function getApp(name, version) {
    if (!(name in this._apps)) {
      return null;
    }

    return this._apps[name][version];
  },

  /**
   * Registers an application for token support.
   */
  registerApp: function registerApplication(name, version, endpoint) {
    if (!(name in this._apps)) {
      this._apps[name] = {};
    }

    let app = this._apps[name];
    if (version in app) {
      throw new Error("Application already registered.");
    }

    app[version] = {
      name:     name,
      version:  version,
      endpoint: endpoint,
    };

    let nameVersionPair = name + "/" + version;
    let path = this._pathPrefix + "/" + nameVersionPair;

    this.server.registerPathHandler(path,
                                    this._appHandler.bind(this, name, version));
  },

  /**
   * Find and return the user that has a specific assertion registered.
   *
   * If no user has the specified assertion, returns null;
   */
  getUserWithAssertion: function getUserWithAssertion(assertion) {
    for each (let user in this._users) {
      if (user.hasAssertion(assertion)) {
        return user;
      }
    }

    return null;
  },

  /**
   * Generate a new token pair.
   *
   * @return Array of [id, key]
   */
  generateToken: function generateToken() {
    let id = "token-id-" + this._tokenCounter;
    let key = "token-key-" + this._tokenCounter;

    this._tokenCounter += 1;

    return [id, key];
  },

  _appHandler: function _appHandler(name, version, request, response) {

    let app = this.getApp(name, version);
    if (!app) {
      throw new Error("App not found. Server used incorrectly!");
    }

    let method = request.method;
    switch (method) {
      case "GET":
        return this._getTokenHandler(app, request, response);

      default:
        response.setStatusLine(request.httpVersion, 405, "Method Not Allowed");
        response.setHeader("Allow", "GET");
      }
    };
  },

  /**
   * Handler processed to obtain a token for an app.
   */
  _getTokenHandler: function _getTokenHandler(app, request, response) {
    let needsAuth = true;
    let assertion;

    function sendUnauthorized() {
      response.setStatusLine(request.httpVersion, 401, "Unauthorized");
      response.setHeader("WWW-Authenticate", "Browser-ID");
    }

    if (!request.hasHeader("authorization")) {
      sendUnauthorized();
      return;
    }

    let header = request.getHeader("authorization");
    if (header.indexOf("Browser-ID ")) {
      sendUnauthorized();
      return;
    }

    let assertion = header.substr(11);

    let user = this.getUserWithAssertion(assertion);
    if (!user) {
      sendUnauthorized();
      return;
    }

    // Generate and assign new token.
    let [id, key] = this.generateToken();

    user.registerToken(app.name, app.version, id, key);

    let result = {
      id:           id,
      key:          key,
      uid:          user.uid,
      api_endpoint: app.endpoint,
    };

    let body = JSON.stringify(result);
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/json");
    response.bodyOutputStream.write(body, body.length);
  },
};
