/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file essentially contains the high-level logic for performing a
 * sync.
 *
 * A single sync consists of roughly two components:
 *
 *   - A GlobalState instance which tracks the global state of the Sync client.
 *   - A GlobalSession instance whild manages an individual sync operation.
 *
 * You first instantiate a GlobalState instance and populate all available
 * state. Then, you pass this state off to a new GlobalSession instance and
 * begin a sync operation. GlobalSession examines the state of GlobalState and
 * moves through the sync process.
 */

"use strict";

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

const EXPORTED_SYMBOLS = [
  "GlobalConfiguration",
  "GlobalSession",
  "GlobalState",
];

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/stages.js");
Cu.import("resource://services-sync/util.js");

const PREFS = new Preferences(PREFS_BRANCH);

/**
 * Holds global configuration for Sync.
 *
 * Values held by this type are essentially directly under the user's control
 * or can be directly influenced by the user.
 */
function GlobalConfiguration() {
  this.allowServerRootKeyStorage = true;
  this.requireStrongKeyWrapping = false;

  this.authenticationMode = "basic";

  this.tokenServerURL = null;
  this.storageServerURL = null;

  this.basicUsername = null;
  this.basicPassword = null;

  this.rootKeyBundle = null;

  this.keyRecordID = "keys";
}
GlobalConfiguration.prototype = {
  /**
   * Whether the root encryption key can be stored (encrypted) on the storage
   * server.
   */
  allowServerRootKeyStorage: true,

  /**
   * Whether to require cryptographically secure wrapping of the root key.
   *
   * If set to false, Sync will allow the root key to be wrapped with keys
   * that may be derived from less secure sources, such as passwords.
   */
  requireStrongKeyWrapping: false,

  /**
   * How to authenticate with the storage server.
   *
   * Supports "basic" or "token" by default.
   */
  authenticationMode: null,

  /**
   * String URL to use to obtain an access token.
   */
  tokenServerURL: null,

  /**
   * URL of storage server to connect to.
   *
   * If using a token server, this should never be defined and the server is
   * discovered when obtaining a token.
   */
  storageServerURL: null,

  /**
   * If authenticating with HTTP basic credentials, the username and password
   * to use.
   */
  basicUsername: null,
  basicPassword: null,

  /**
   * The nsIKeyBundle instance providing the root encryption key pair.
   *
   * If the root key is stored encrypted on the server, this should be null.
   */
  rootKeyBundle: null,

  /**
   * The ID of the record in the "crypto" collection where to look for
   * encrypted keys.
   */
  keyRecordID: null,

  /**
   * Loads state from the environment.
   */
  loadExternalState: function loadExternalState() {
    this.loadBasicCredentials();
  },

  /**
   * Loads basic credentials from the password manager.
   *
   * Side effect is basicUsername and basicPassword are populated if
   * credentials are available.
   *
   * This may throw if the password manager is locked by the master password.
   *
   * @return boolean
   *         Whether credentials were found.
   */
  loadBasicCredentials: function loadBasicCredentials() {
    this.basicUsername = PREFS.get("username", null);
    this.basicPassword = null;

    if (!this.basicUsername) {
      return false;
    }

    let logins = Services.logins.findLogins({}, PWDMGR_HOST, null,
                                            PWDMGR_PASSWORD_REALM);

    for each (let login in logins) {
      if (login.username.toLowerCase() != this.basicUsername) {
        continue;
      }

      this.basicPassword = Utils.encodeUTF8(login.password);
    }

    return !!this.basicPassword;
  },
};
Object.freeze(GlobalConfiguration.prototype);

/**
 * Holds the global state of a Sync client.
 *
 * This holds state that needs to persist across multiple sync sessions.
 *
 * This type should hold information that is pertinent to multiple sync
 * operations. e.g. if a piece of data needs to outlive an individual sync
 * session, it should go here. If a piece of data is relavant to only a single
 * sync session, it should go in GlobalSession.
 */
function GlobalState() {
  this.storageServerURL = null;

  this.remoteCollectionsLastModified = null;
  this.remoteSyncID = null;
  this.remoteStorageVersion = null;
  this.remoteRepositoryInfo = null;
  this.collectionKeys = null;
}
GlobalState.prototype = {
  /**
   * URL prefix of our storage server.
   *
   * Sometimes this is copied from the GlobalConfiguration. Sometimes it is
   * determined at sync time.
   */
  storageServerURL: null,

  /**
   * Mapping of last modified times of collections on the server.
   *
   * This essentially holds the results of an info/collections request.
   */
  remoteCollectionsLastModified: null,

  /**
   * Global Sync ID reported on the server (from meta/global).
   */
  remoteSyncID: null,

  /**
   * Storage version on the server (from meta/global).
   */
  remoteStorageVersion: null,

  /**
   * Metadata about repositories on the server (from meta/global).
   *
   * Is an object when populated. Keys are repository/collection names. Values
   * are objects with keys "syncID" and "version".
   */
  remoteRepositoryInfo: null,

  /**
   * Holds known collection keys.
   *
   * This is an object when there are known collection keys. Keys are
   * collection names. Values are nsIKeyBundle instances.
   */
   collectionKeys: null,

  /**
   * Load state from external sources.
   *
   * This is just a convenience function which calls the main worker functions
   * below.
   */
  loadExternalState: function loadExternalState() {
    this.loadPreferences();
  },

  /**
   * Load state from preferences.
   */
  loadPreferences: function loadPreferences() {
    // These prefs mostly copied from service.js. Some may not be relevant
    // any more.
    const PREF_MAP = {
      serverURL:         "serverURL",
      clusterURL:        "clusterURL",
      miscURL:           "miscURL",
      userURL:           "userURL",
      localSyncID:       "client.syncID",
      lastClusterUpdate: "lastClusterUpdate",
      lastPing:          "lastPing",
    };

    for (let [k, v] in Iterator(PREF_MAP)) {
      this[k] = Svc.Prefs.get(v, null);
    }
  },
};

/**
 * Manage a single sync session.
 *
 * This type is what performs an actual sync. You simply instantiate an
 * instance tied to a GlobalState, launch the sync, and wait for it to
 * complete successfully or bail early with an error.
 *
 * A sync session is composed of individual steps called stages. Each stage
 * represents a very specific action or role in the sync process. For example,
 * a stage may check whether syncing is currently allowed or may fetch the
 * cryptographic keys from the server.
 *
 * The session proceeds through stages linearly. Once entered, each stage exits
 * with either a successful or error result. If successful, the session moves
 * on to the next stage. If there is an error, the sync aborts immediately.
 *
 * A sync session can only be started once. To begin a new sync, simply create
 * a new session.
 *
 * @param globalState
 *        (GlobalState) State instance we are bound to.
 */
function GlobalSession(globalState) {
  this.state = globalState;

  this._log = Log4Moz.repository.getLogger("Services.Sync.GlobalSession");
  this._log.level = Log4Moz.Level[Svc.Prefs.get("log.logger.globalsession")];

  this.stages = this.STAGES.map(function createStage(fn) {
    return fn.prototype.constructor.call(this, this);
  }, this);

  // Will hold the SyncClient instance. Populated by
  // CreateStorageServiceClientStage.
  this.syncClient = null;
}
GlobalSession.prototype = {
  STAGES: [
    CheckPreconditionsStage,
    EnsureServiceCredentialsStage,
    EnsureSyncKeyStage,
    EnsureClusterURLStage,
    CreateStorageServiceClientStage,
    FetchInfoCollectionsStage,
    ProcessInfoCollectionsStage,
    EnsureSpecialRecordsStage,
    UpdateRepositoryStateStage,
    SyncClientsRepositoryStage,
    ProcessFirstSyncPrefStage,
    ProcessClientCommandsStage,
    SyncRepositoriesStage,
    FinishStage,
  ],

  /**
   * Holds the current index in the stages list we are traversing.
   */
  currentStageIndex: -1,

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
    if (error || this.currentStageIndex >= this.stages.length) {
      this.finish(error);
      return;
    }

    this.currentStatgIndex += 1;
    let stage = this.stages[this.currentStateIndex];

    try {
      stage.begin();
    } catch (ex) {
      this._log.warn("Uncaught exception when processing stage: " +
                     CommonUtils.exceptionStr(ex));
      this.advance(ex);
    }
  },

  /**
   * Begin a sync.
   *
   * The caller should ensure that only one GlobalSession's begin() function
   * is active at one time.
   */
  begin: function begin(callback) {
    if (this.currentStageIndex != -1) {
      throw new Error("GlobalSession has already begun! Can't call begin() " +
                      "multiple times!");
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

  //---------------------------------
  // StorageServiceClient Listeners |
  //---------------------------------

  onAuthFailure: function onAuthFailure(client, request) {
    if (request.ignoreFailures) {
      return;
    }

    // TODO may need additional side-effects.
    this.advance(new Error("Authentication failure!"));
  },

  onBackoffReceived: function onBackoffReceived(client, request, interval,
                                                success) {
    //Status.enforceBackoff = true;

    // TODO set Status.{sync,login} to SERVER_MAINTENANCE?

    //Svc.Obs.notify("weave:service:backoff:interval", interval / 1000);

  },

  onNetworkError: function onNetworkError(client, request, error) {
    switch (error.result) {
      case Cr.NS_ERROR_UNKNOWN_HOST:
      case Cr.NS_ERROR_CONNECTION_REFUSED:
      case Cr.NS_ERROR_NET_TIMEOUT:
      case Cr.NS_ERROR_NET_RESET:
      case Cr.NS_ERROR_NET_INTERRUPT:
      case Cr.NS_ERROR_PROXY_CONNECTION_REFUSED:
        // TODO take appropriate side-effect.
        /*
        // The constant says it's about login, but in fact it just
        // indicates general network error.
        if (this._service.isLoggedIn) {
          Status.sync = LOGIN_FAILED_NETWORK_ERROR;
        } else {
          Status.login = LOGIN_FAILED_NETWORK_ERROR;
        }
        */
        break;

      default:
        this._log.info("Unhandled network error: " + error.result);
    }
  },

  onQuotaRemaining: function onQuotaRemaining(client, request, remaining) {
    // TODO Perform desired side-effect.
    //Svc.Obs.notify("weave:service:quota:remaining", remaining);
  },
};
