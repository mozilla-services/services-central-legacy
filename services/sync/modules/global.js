/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file defines types used to manage the global configuration and
 * state of Sync clients. If you are looking for the core logic of a Sync
 * client, this is where it's at.
 */

const {classes: Cc, interfaces: Ci, results: Cr, Utils: Cu} = Components;

const EXPORTED_SYMBOLS = ["GlobalSession"];

Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/log4moz.js");

/**
 * Holds the global state of a Sync client.
 *
 * This holds server information, credentials, root keys, and other misc
 * data.
 *
 * This type is effectively a convenient container. While functions are
 * available to load and save state from and to external resources, it should
 * be possible to instantiate multiple instances of GlobalState without
 * conflicts.
 *
 * Instances can serve as proxies to other type instances which specialize in
 * managing specific state. For example, instances can be hooked up with
 * IdentityManager instances to manage identity-related credentials.
 */
function GlobalState() {
  this.serverURL = null;
  this.clusterURL = null;

  this.username = null;
  this.basicPassword = null;
  this.syncKeyBundle = null;

  this._identityConnected = false;
}
GlobalState.prototype = {
  IDENTITY_PROPERTIES: [
    "account",
    "username",
    "basicPassword",
    "syncKey",
    "syncKeyBundle",
  ],

  /**
   * Whether we have information on the server to connect to.
   */
  get haveServerInfo() {

  },

  /**
   * Connect this state with an IdentityManager instance.
   *
   * By default, state instances are self-contained. After calling this,
   * instances are bound to an IdentityManager instance. In other words, this
   * hooks up the plumbing so attributes are loaded from preferences, changes
   * are saved to the login manager, etc.
   *
   * @param identity
   *        (IdentityManager) IdentityManager instance to use. If falsy, the
   *        global instance will be used.
   */
  connectWithIdentity: function connectWithIdentity(identity) {
    if (!identity) {
      identity = Identity;
    }

    for each (let property in this.IDENTITY_PROPERTIES) {
      Object.defineProperty(this, property, {
        get: identity.__lookupGetter__(property),
        set: identity.__lookupSetter__(property)
      });
    }

    this._identityConnected = true;
  },
};

const SYNC_STATUS_OK             = 0;
const SYNC_STATUS_NO_CREDENTIALS = 1;

/**
 * Create a new Sync session tied to specific global state.
 *
 * @param globalState
 *        (GlobalState) State instance we are bound to.
 */
function GlobalSession(globalState) {
  this.state = state;
  this.boundAdvance = this.advance.bind(this);

  this._log.level = Log4Moz.Level[Svc.Prefs.get("log.logger.globalsession")];
}
GlobalSession.prototype = {
  _log: Log4Moz.repository.getLogger("Sync.GlobalSession"),

  /**
   * Defines the order of the functions called on the local object during a
   * sync.
   */
  STATE_FLOW: [
    "checkPreconditions",
    "ensureClusterURL",
    "fetchInfoCollections",
    "ensureSpecialRecords",
    "updateEngineTimestamps",
    "syncClientsEngine",
    "processFirstSyncPref",
    "processClientCommands",
    "updateEnabledEngines",
    "syncEngines"
  ],

  /**
   * Holds the current index in STATE_FLOW the session is operating in.
   */
  currentStateIndex: -1,

  /**
   * Callback invoked when sync attempt has finished, regardless of success or
   * failure.
   */
  finishedCallback: null,

  /**
   * Advance the state pointer and execute the next transition in the state flow.
   */
  advance: function advance(error) {
    // We are on the last state and are thus done.
    if (error || this.currentStateIndex >= this.STATE_FLOW.length) {
      this.finish(error);
      return;
    }

    this.currentStateIndex += 1;
    let f = this[STATE_FLOW[this.currentStateIndex]];
    f.call(this, this.boundAdvance);
  },

  /**
   * Begin a sync.
   *
   * The caller should ensure that only one GlobalSession's begin() function
   * is active at one time.
   */
  begin: function begin(callback) {
    if (this.currentStateIndex != -1) {
      callback("XXX TODO already begun, current state index is " +
               this.currentStateIndex);
      return;
    }
    this.finishedCallback = callback;
    this.advance(null);
  },

  /**
   * Helper function called whenever the sync process finishes.
   *
   * @param  error
   *         Error code (eventually object) to be passed to callback which is
   *         defined on sync start.
   */
  finish: function finish(error) {
    this.finishedCallback(error);
  },

  // --------------------------------------------------------------------------
  // What follows are the handlers for specific states during an individual   |
  // sync. They are defined in the order in which they are executed.          |
  // --------------------------------------------------------------------------

  checkPreconditions: function checkPreconditions(callback) {
    Status.resetSync();
    let status = Status.checkSetup();

    if (status == CLIENT_NOT_CONFIGURED) {
      return callback("XXX TODO client not configured");
    }
    if (Svc.Prefs.get("firstSync") == "notReady") {
      return callback("XXX TODO still setting up");
    }
    if (Services.io.offline) {
      return callback("XXX TODO no can haz interwebs");
    }
    if (Status.minimumNextSync > Date.now()) {
      return callback("XXX TODO backoff not met");
    }
    if ((Status.login == MASTER_PASSWORD_LOCKED) &&
        Utils.mpLocked()) {
      return callback("XXX TODO master password is still locked");
    }

    return callback(null);
  },

  _fetchedClusterURL: false,
  ensureClusterURL: function ensureClusterURL(callback) {
    if (Service.clusterURL) {
      callback(null);
      return;
    }

    let url = Service.userAPI + Service.username + "/node/weave";
    //XXX TODO we also want to pay attention to backoff on this call, but it's
    // not as simple as using SyncStorageRequest because that does auth.
    let request = new RESTRequest(url).get(function (error) {
      if (error) {
        this._log.debug("ensureClusterURL failed: " + Utils.exceptionStr(error));
        Status.login = LOGIN_FAILED_NETWORK_ERROR;
        return callback({exception: error});
      }
      let response = request.response;
      switch (response.status) {
        case 400:
          this._log.debug("Server responded error code ");
          Status.login = LOGIN_FAILED_LOGIN_REJECTED;
          return callback("XXX TODO find cluster denied: " +
                          ErrorHandler.errorStr(response.body));
        case 404:
          this._log.debug("Server doesn't support user API. " +
                          "Using serverURL as data cluster");
          Service.clusterURL = Service.serverURL;
          break;
        case 200:
          let node = request.body;
          if (node == "null") {
            node = null;
          }
          this._log.trace("node/weave returned " + node);
          Service.clusterURL = node;
          break;
        default:
          return callback({httpResponse: response});
          break;
      }

      this._fetchedClusterURL = true;
      return callback(null);
    }.bind(this));
  },

  infoCollections: null,

  fetchInfoCollections: function fetchInfoCollections(callback) {
    // Ping the server with a special info request once a day.
    let url = Service.infoURL;
    let now = Math.floor(Date.now() / 1000);
    let lastPing = Svc.Prefs.get("lastPing", 0);
    if (now - lastPing > 86400) { // 60 * 60 * 24
      url += "?v=" + WEAVE_VERSION;
      Svc.Prefs.set("lastPing", now);
    }
    let request = new SyncStorageRequest(url).get(function (error) {
      if (error) {
        this._log.debug("fetchInfoCollections failed: " +
                        Utils.exceptionStr(error));
        Status.login = LOGIN_FAILED_NETWORK_ERROR;
        return callback({exception: error});
      }
      let response = request.response;

      // A 401 or 404 response code can mean we're talking to wrong node or
      // we're using the wrong credentials. Only way to find out is to refetch
      // the node and then try again.
      if (response.status == 401 || response.status == 404) {
        // Did we already try fetching the clusterURL this sync? If so, it seems
        // that we've got incorrect credentials.
        if (this._fetchedClusterURL) {
          Status.login = LOGIN_FAILED_LOGIN_REJECTED;
          return callback({httpResponse: response});
        }
        // Could be a node-reassingment. Refetch the clusterURL, then go back to
        // this function.
        Svc.Prefs.reset("clusterURL");
        return this.ensureClusterURL(function (error) {
          if (error) {
            return callback(error);
          }
          return this.fetchInfoCollections(callback);
        });
      }

      // Any non 200 response codes: something's wrong, abort!
      if (response.status != 200) {
        return callback({httpResponse: response});
      }

      try {
        this.infoCollections = JSON.parse(response.body);
      } catch (ex) {
        return callback({exception: ex});
      }

      return callback(null);
    }.bind(this));
  },

  ensureSpecialRecords: function ensureSpecialRecords(callback) {
    // - fetch keys if 'crypto' timestamp differs from local one
    //   - if it's non-existent, goto fresh start.
    //   - decrypt keys with Sync Key, abort if HMAC verification fails.
    // - fetch meta/global if 'meta' timestamp differs from local one
    //   - if it's non-existent, goto fresh start.
    //   - check for storage version. if server data outdated, goto fresh start.
    //     if client is outdated, abort with friendly error message.
    //   - if syncID mismatch, reset local timestamps, refetch keys
    // - if fresh start:
    //   - wipe server. all of it.
    //   - create + upload meta/global
    //   - generate + upload new keys
    return callback(null);
  },

  updateEngineTimestamps: function updateEngineTimestamps(callback) {
    // - update engine last modified timestamps from info/collections record
    return callback(null);
  },

  syncClientsEngine: function syncClientsEngine(callback) {
    // clients engine always fetches all records
    return callback(null);
  },

  processFirstSyncPref: function processFirstSyncPref(callback) {
    // process reset/wipe requests in 'firstSync' preference
    return callback(null);
  },

  processClientCommands: function processClientCommands(callback) {
    // includes wipeClient commands, et al
    return callback(null);
  },

  updateEnabledEngines: function updateEnabledEngines(callback) {
    // infer enabled engines from meta/global
    return callback(null);
  },

  syncEngines: function syncEngines(callback) {
    // only stop if 401 seen
    return callback(null);
  }
};
