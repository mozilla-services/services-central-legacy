/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file defines types used to manage the global configuration and
 * state of Sync clients. If you are looking for the core logic of a Sync
 * client, this is where it's at.
 */

"use strict";

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

  this.remoteCollectionsLastModified = {};
  this.remoteSyncID = null;
  this.remoteStorageVersion = null;
  this.remoteEngineInfo = {};
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
};
