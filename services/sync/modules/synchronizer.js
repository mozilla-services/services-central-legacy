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
 *   Richard Newman <rnewman@mozilla.com>
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

Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/util.js");

const EXPORTED_SYMBOLS = ["Synchronizer"];

/**
 * A SynchronizerSession exchanges data between two RepositorySessions.
 * As with other kinds of session, this is a one-shot object.
 *
 * SynchronizerSession is an implementation detail of the Synchronizer. It is
 * not a public class.
 *
 * Grab a session for each of our repositories. Once both sessions are set
 * up, we pair invocations of fetchSince and store callbacks, switching
 * places once the first stream is done. Then we finish each session and
 * invoke our callback.
 *
 * Example usage:
 *
 *   let session = new SynchronizerSession(synchronizer);
 *   session.onInitialized = function (err) {
 *     // Add error handling here.
 *     session.synchronize();
 *   };
 *   session.onSynchronized = function (err) {
 *     // Rock on!
 *     callback(err);
 *   };
 *   session.init();
 */
function SynchronizerSession(synchronizer) {
  this.synchronizer = synchronizer;

  let level = Svc.Prefs.get("log.logger.synchronizer");
  this._log = Log4Moz.repository.getLogger("Sync.Synchronizer");
  this._log.level = Log4Moz.Level[level];
}
SynchronizerSession.prototype = {
  sessionA:     null,
  sessionB:     null,
  synchronizer: null,

  //
  // TODO: Need to persist all of these.
  //
  timestampA:  null,
  timestampB:  null,
  bundleA:     null,
  bundleB:     null,

  /**
   * Override these two methods!
   * TODO: comments
   */
  onInitialized: function onInitialized(error) {
    throw "Override onInitialized.";
  },

  onSynchronized: function onSynchronized(error) {
    throw "Override onSynchronized.";
  },

  /**
   * Override this if you want to terminate fetching, or apply
   * other recovery/etc. handling.
   */
  onFetchError: function onFetchError(error, record) {
    // E.g., return Repository.prototype.STOP;
  },

  /**
   * storeCallback doesn't admit any kind of control flow, so only bother
   * overriding this if you want to watch what's happening.
   */
  onStoreError: function onStoreError(error) {
  },

  // TODO
  onSessionError: function onSessionError(error) {
  },

  // TODO: bind and currying session.
  fetchCallback: function fetchCallback(session, error, record) {
    if (error) {
      this._log.warn("Got error " + Utils.exceptionStr(error) +
                     " fetching. Invoking onFetchError for handling.");
      // Return the handler value, which allows the caller to do useful things
      // like abort.
      return this.onFetchError(error, record);
    }
    session.store(record);
    return null;
  },

  /**
   * The two storeCallbacks are instrumental in switching sync direction and
   * actually finishing the sync. This is where the magic happens.
   */
  storeCallbackB: function storeCallbackB(error) {
    if (error != Repository.prototype.DONE) {
      // Hook for handling. No response channel yet.
      this.onStoreError(error);
      return;
    }
    this._log.trace("Done with records in storeCallbackB.");
    this._log.trace("Fetching from B into A.");
    // On to the next!
    this.sessionB.begin(function (err) {
      if (err) {
        // Hook for handling. No response channel yet.
        this.onSessionError(error);
        return;
      }
      this.sessionB.fetchSince(this.synchronizer.lastSyncB,
                               this.fetchCallback.bind(this, this.sessionA));
    }.bind(this));
  },

  storeCallbackA: function storeCallbackA(error) {
    this._log.debug("In storeCallbackA().");
    if (error != Repository.prototype.DONE) {
      this.onStoreError(error);
      return;
    }
    this._log.trace("Done with records in storeCallbackA.");
    this.finishSync();
  },

  sessionCallbackA: function sessionCallbackA(error, session) {
    if (error) {
      this.onInitialized(error);
      return;
    }
    this.sessionA = session;
    session.unbundle(this.bundleA);
    this.synchronizer.repositoryB.createSession(this.storeCallbackB.bind(this),
                                                this.sessionCallbackB.bind(this));
  },

  sessionCallbackB: function sessionCallbackB(error, session) {
    if (error) {
      return this.sessionA.finish(function () {
        this.onInitialized(error);
      }.bind(this));
    }
    this.sessionB = session;
    session.unbundle(this.bundleB);
    this.onInitialized();
  },

  /**
   * Dispose of both sessions and invoke onSynchronized.
   */
  finishSync: function finishSync() {
    this.sessionA.finish(function (timestampA, bundle) {
      this.timestampA = timestampA;
      this.bundleA    = bundle;
      this.sessionB.finish(function (timestampB, bundle) {
        this.timestampB = timestampB;
        this.bundleB    = bundle;
        // Finally invoke the output callback.
        this.onSynchronized(null);
      }.bind(this));
    }.bind(this));
  },

  /**
   * Initialize the two repository sessions, then invoke onInitialized.
   */
  init: function init() {
    this.synchronizer
        .repositoryA.createSession(this.storeCallbackA.bind(this),
                                   this.sessionCallbackA.bind(this));
  },

  /**
   * Assuming that two sessions have been initialized, sync, then clean up and
   * invoke onSynchronized.
   */
  synchronize: function synchronize() {
    this.sessionA.begin(function (err) {
      if (err) {
        // Hook for handling. No response channel yet.
        this.onSessionError(err);
        return;
      }
      this.sessionA.fetchSince(this.synchronizer.lastSyncA,
                               this.fetchCallback.bind(this, this.sessionB));
    }.bind(this));
  }
};

/**
 * A Synchronizer exchanges data between two Repositories.
 *
 * It tracks whatever information is necessary to reify the syncing
 * relationship between these two sources/sinks: e.g., last sync time.
 *
 * The synchronizer must keep track of the set of IDs that have been stored and
 * not modified since the session last fetched new records. That is, a record
 * which has been received from another source should not be re-uploaded to
 * that source, regardless of timestamp, unless it is changed locally.
 *
 * This is to avoid endless uploads of the same record from repository to
 * repository. It seems fragile to rely on reconciliation and not modifying
 * timestamps to eliminate a loop.
 *
 * There are two situations in which this might occur:
 *
 * * In store-first-fetch-second, this could occur inside the same session.
 * * In fetch-first-store-second, this could occur in a subsequent session.
 *
 * Note that one-session memory is not enough: a fetch could easily be aborted
 * before the new item has been reached, leaving it open for re-upload later.
 *
 * This tracking is obviously specific to a synchronizer, not to the
 * repository, but it is calculated by the session itself, because the set of
 * tracked IDs for a given sequence of stores depends on the process of
 * reconciliation.
 *
 * - On store, track the ID.
 * - On fetch, skip items that have been stored.
 * - TODO: If a subsequent fetch predates our stored timestamp, do not skip records.
 * - When an item is modified locally, remove it from the tracker.
 */

function Synchronizer() {
  let level = Svc.Prefs.get("log.logger.synchronizer");
  this._log = Log4Moz.repository.getLogger("Sync.Synchronizer");
  this._log.level = Log4Moz.Level[level];
}
Synchronizer.prototype = {

  /**
   * Keep track of timestamps. These need to be persisted.
   */
  lastSyncA: 0,
  lastSyncB: 0,
  // TODO: bundles

  /**
   * Repositories to sync.
   *
   * The synchronizer will first sync from A to B and then from B to A.
   */
  repositoryA: null,
  repositoryB: null,

  /**
   * Do the stuff to the thing.
   */
  synchronize: function synchronize(callback) {
    this._log.trace("Entering Synchronizer.synchronize().");

    let session = new SynchronizerSession(this);
    session.onSessionError = function (error) {
      this._log.warn("Error in SynchronizerSession: " +
                     Utils.exceptionStr(error));
      return callback(error);
    };
    session.onInitialized = function (error) {
      // Invoked with session as `this`.
      if (error) {
        this._log.warn("Error initializing SynchronizerSession: " +
                       Utils.exceptionStr(error));
        return callback(error);
      }
      session.synchronize();
    };
    session.onSynchronized = function (error) {
      // Invoked with session as `this`.
      if (error) {
        this._log.warn("Error during synchronization: " +
                       Utils.exceptionStr(error));
        return callback(error);
      }
      // Copy across the timestamps from within the session.
      session.synchronizer.lastSyncA = session.timestampA;
      session.synchronizer.lastSyncB = session.timestampB;
      // TODO: copy bundle.
      callback();
    };
    session.init();
  },

  /**
   * Synchronize. This method blocks execution of the caller. It is deprecated
   * and solely kept for backward-compatibility.
   */
  sync: function sync() {
    Async.callSpinningly(this, this.synchronize);
  }
};


/**
 * Synchronize a Firefox engine to a Server11Collection.
 *
 * N.B., this class layers two accessors -- local and remote -- on top of the
 * undiscriminated pair of repositories exposed by Synchronizer.
 */
function EngineCollectionSynchronizer(name, local, remote) {
  Synchronizer.call(this);
  this.Name = name;
  this.name = name.toLowerCase();
  this.repositoryA = local;
  this.repositoryB = remote;
}
EngineCollectionSynchronizer.prototype = {
  __proto__: Synchronizer.prototype,

  /**
   * Convention.
   */
  get localRepository()  this.repositoryA,
  get serverRepository() this.repositoryB,

  /**
   * lastSync is a timestamp in server time.
   */
  get lastSync() {
    return parseFloat(Svc.Prefs.get(this.name + ".lastSync", "0"));
  },
  set lastSync(value) {
    // Reset the pref in-case it's a number instead of a string
    Svc.Prefs.reset(this.name + ".lastSync");
    // Store the value as a string to keep floating point precision
    Svc.Prefs.set(this.name + ".lastSync", value.toString());
  },

  /**
   * lastSyncLocal is a timestamp in local time.
   */
  get lastSyncLocal() {
    return parseInt(Svc.Prefs.get(this.name + ".lastSyncLocal", "0"), 10);
  },
  set lastSyncLocal(value) {
    // Store as a string because pref can only store C longs as numbers.
    Svc.Prefs.set(this.name + ".lastSyncLocal", value.toString());
  },
};
