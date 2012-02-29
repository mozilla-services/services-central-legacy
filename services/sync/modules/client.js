/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = [
  "MetaGlobalRequestError",
  "SyncClient",
];

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/policies.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/status.js");
Cu.import("resource://services-sync/storageservice.js");
Cu.import("resource://services-sync/util.js");

function MetaGlobalRequestError(message, condition) {
  this.message   = message;
  this.condition = condition;

}
MetaGlobalRequestError.prototype = {
  __proto__: Error.prototype,

  NETWORK:   1,
  NOT_FOUND: 2,
  SERVER:    3,
};

/**
 * This is a Sync-specific client for the storage service.
 *
 * This type extends StorageServiceClient to provide Sync-specific
 * implementation details.
 *
 * TODO need to set Status.enforceBackoff in case of 5xx errors (see
 * policies.js)
 */
function SyncClient(baseURI, service) {
  StorageServiceClient.call(this, baseURI);

  this._service = service;

  this.addListener(this);
}
SyncClient.prototype = {
  __proto__: StorageServiceClient.prototype,

  userAgent:
    Services.appinfo.name + "/" + Services.appinfo.version +  // Product.
    " FxSync/" + WEAVE_VERSION + "." +                        // Sync.
    Services.appinfo.appBuildID + ".",                        // Build.

  /**
   * Obtain request that gets collection info, possibly including a ping.
   *
   * This overrides the parent function to possibly include a daily ping to
   * the Sync server.
   *
   * TODO Apparently there is a bug open on metrics to not rely on this and
   * this can be removed since they are getting the version from the UA.
   */
  getCollectionInfo: function getCollectionInfo() {
    let request = StorageServiceClient.prototype.getCollectionInfo.call(this);

    let now = Date.now();
    let lastPing = parseInt(Svc.Prefs.get("lastPing", 0), 10);
    if (now - lastPing > 864000000) {
      Svc.Prefs.set("lastPing", now.toString());
      request.request.uri.path += "?v=" + WEAVE_VERSION;
    }

    return request;
  },

  /**
   * Validate credentials by attempting a simple request.
   *
   * The supplied callback will be invoked with the following arguments:
   *
   *   (bool) Indicates whether request completed successfully in terms of
   *     credentials working.
   *   (string) LOGIN_FAILED_* constant for the error.
   */
  validateCredentials: function validateCredentials(cb) {
    let request = this.getCollectionInfo();

    request.ignoreFailures = true;

    request.onComplete = function() {
      let info = {
        authFailure:       false,
        networkError:      false,
        serverError:       false,
        serverMaintenance: false,
      };

      if (request.networkError) {
        info.networkError = true;
        cb(false, info);
        return;
      }

      switch (request.statusCode) {
        case 200:
          cb(true, info);
          return;

        case 401:
        case 404:
          info.authFailure = true;
          cb(false, info);
          return;

        case 500:
        case 501:
        case 502:
          info.serverError = true;
          cb(false, info);
          return;

        case 503:
          info.serverMaintenance = true;
          cb(false, info);
          return;

        default:
          cb(false, info);
          return;
      }
    };
    request.dispatch();
  },

  /**
   * Fetch the global metadata record.
   *
   * Upon completion, the specified callback will be invoked. The callback
   * receives the arguments:
   *
   *   (MetaGlobalRequestError) Instance explaining error that occurred or null
   *     if there was no error.
   *
   *   (MetaGlobalRecord) The fetched record or null if the record could not be
   *     obtained.
   *
   * @param cb
   *        (function) Callback to be invoked with result of operation.
   */
  fetchMetaGlobal: function fetchMetaGlobal(cb) {
    let request = this.getBSO("meta", "global", MetaGlobalRecord);
    request.onComplete = function() {
      let error;

      if (this.networkError) {
        error = new MetaGlobalRequestError(this.networkError.message,
                                           MetaGlobalRequestError.NETWORK);
      } else if (this.clientError) {
        error = new MetaGlobalRequestError(this.clientError.message,
                                           MetaGlobalRequestError.SERVER);
      } else if (this.notFound) {
        error = new MetaGlobalRequestError("404 received",
                                           MetaGlobalRequestError.NOT_FOUND);
      }

      if (error) {
        cb(error, null);
        return;
      }

      cb(null, this.resultObj);
    };
    request.dispatch();
  },

  /**
   * Delete the global metadata record.
   *
   * The passed callback is invoked after the deletion request is completed.
   * It receives as its single argumen an Error object which will be defined
   * if an error was encountered.
   *
   * @param cb
   *        (function) Callback to be invoked on request completion.
   */
  deleteMetaGlobal: function deleteMetaGlobal(cb) {
    let request = this.deleteBSO("meta", "global");
    request.onComplete = function() {
      if (!cb) {
        return;
      }

      cb(this.error);
    };
    request.dispatch();
  },

  //--------------------------------
  //StorageServiceClient Listeners |
  //--------------------------------

  onAuthFailure: function onAuthFailure(client, request) {
    // Conspire with certain requests to ignore failures.
    if (request.ignoreFailures) {
      return;
    }

    // TODO code was stolen from policies.js. Ensure accurancy and DRY.
    this._service.logout();
    this._log.info("Got 401 response; resetting clusterURL.");
    Svc.Prefs.reset("clusterURL");

    let delay = 0;
    if (Svc.Prefs.get("lastSyncReassigned")) {
      this._log.warn("Last sync also failed for 401. Delaying next sync.");
      delay = MINIMUM_BACKOFF_INTERVAL;
    } else {
      this._log.debug("New mid-sync 401 failure. Making a note.");
      Svc.Prefs.set("lastSyncReassigned", true);
    }

    this._log.info("Attempting to schedule another sync.");
    SyncScheduler.scheduleNextSync(delay);
  },

  onBackoffReceived: function onBackoffReceived(client, request, interval,
                                                success) {

    Status.enforceBackoff = true;
    if (!success) {
      if (this._service.isLoggedIn) {
        Status.sync = SERVER_MAINTENANCE;
      } else {
        Status.login = SERVER_MAINTENANCE;
      }
    }

    Svc.Obs.notify("weave:service:backoff:interval", interval / 1000);

  },

  onDispatch: function onDispatch(client, request) {
    let authenticator = Identity.getRESTRequestAuthenticator();
    if (authenticator) {
      this._log.debug("Adding authentication info to request.");
      authenticator(request.request);
    } else {
      this._log.debug("No authentication info available for request.");
    }
  },

  onNetworkError: function onNetworkError(client, request, error) {
    switch (error.result) {
      case Cr.NS_ERROR_UNKNOWN_HOST:
      case Cr.NS_ERROR_CONNECTION_REFUSED:
      case Cr.NS_ERROR_NET_TIMEOUT:
      case Cr.NS_ERROR_NET_RESET:
      case Cr.NS_ERROR_NET_INTERRUPT:
      case Cr.NS_ERROR_PROXY_CONNECTION_REFUSED:
        // The constant says it's about login, but in fact it just
        // indicates general network error.
        if (this._service.isLoggedIn) {
          Status.sync = LOGIN_FAILED_NETWORK_ERROR;
        } else {
          Status.login = LOGIN_FAILED_NETWORK_ERROR;
        }
        break;

      default:
        this._log.info("Unhandled network error: " + error.result);
    }
  },

  onQuotaRemaining: function onQuotaRemaining(client, request, remaining) {
    Svc.Obs.notify("weave:service:quota:remaining", remaining);
  },
};
