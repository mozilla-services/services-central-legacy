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
  "GlobalSession",
  "GlobalState",
];

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/stages.js");
Cu.import("resource://services-sync/util.js");

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
 *
 * This type should hold information that is pertinent to multiple sync
 * operations. e.g. if a piece of data needs to outlive an individual sync
 * session, it should go here. If a piece of data is relavant to only a single
 * sync session, it should go in GlobalSession.
 */
function GlobalState() {
  this.serverURL = null;
  this.clusterURL = null;

  this.username = null;
  this.basicPassword = null;
  this.syncKeyBundle = null;

  this._identityConnected = false;

  this.remoteCollectionsLastModified = {};
  this.remoteSyncID = null;
  this.remoteStorageVersion = null;
  this.remoteEngineInfo = {};

  this.syncClient = null;
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
   * Load state from external sources.
   *
   * This is just a convenience function which calls the main worker functions
   * below.
   */
  loadExternalState: function loadExternalState() {
    this.loadPreferences();
    this.connectWithIdentity();
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
