/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Firefox Sync.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Philipp von Weitershausen <philipp@weitershausen.de>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

const EXPORTED_SYMBOLS = ["GlobalSession"];

Cu.import("resource://services-sync/status.js");

let MetaGlobal = {

  _record: null,

  modified: false,
  isNew: false,

  fetch: function fetch(callback) {
    if (this._record) {
      callback(null, _record);
      return;
    }
    new SyncStorageRequest(Service.metaURL, function (error, response) {
      //TODO writeme
    });
  },

  store: function store(callback) {
    //TODO write me
  },

  clear: function clear() {
    this._record = null;
  },

  _ensureRecord: function _ensureRecord() {
    if (!this._record) {
      this._record = {};
      this.isNew = true;
    }
  },

  get syncID() {
    return this._record.syncID;
  },
  set syncID(value) {
    this._ensureRecord();
    this._record.syncID = value;
  }
  get storageVersion() {
    return this._record.storageVersion;
  },
  set storageVersion(value) {
    this._ensureRecord();
    this._record.storageVersion = value;
  }
  get engines() {
    return this._record.engines;
  },
  set engines(value) {
    this._ensureRecord();
    this._record.engines = value;
  }

  toJSON: function toJSON() {
    return {syncID:         this.syncID,
            storageVersion: this.storageVersion,
            engines:        this.engines};
  }

};

const SYNC_STATUS_OK             = 0;
const SYNC_STATUS_NO_CREDENTIALS = 1;

/**
 * Create a new Sync session tied to specific global state.
 *
 * The global state instance is a XXX
 * TODO
 */
function GlobalSession(globalState) {
  this.globalState = globalState;
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
