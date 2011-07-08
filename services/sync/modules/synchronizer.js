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
 * A Synchronizer exchanges data between two Repositories.
 *
 * It tracks whatever information is necessary to reify the syncing
 * relationship between these two sources/sinks: e.g., last sync time.
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
    this._log.debug("Entering synchronize().");

    let sessionA;
    let sessionB;

    /**
     * Called when sessionB has stored an item.
     * This happens first.
     */
    function storeCallbackB(error) {
      this._log.debug("In storeCallbackB().");
      if (error == Repository.prototype.DONE) {
        this._log.debug("Done with records in storeCallbackB.");
        this._log.debug("Fetching from B into A.");
        // On to the next!
        sessionB.fetchSince(this.lastSyncB, makeFetchCallback(sessionA));
      } else {
        // TODO
      }
    }

    /**
     * Called when sessionA has stored an item.
     * This happens second.
     */
    function storeCallbackA(error) {
      this._log.debug("In storeCallbackA().");
      if (error == Repository.prototype.DONE) {
        this._log.debug("Done with records in storeCallbackA.");
        // We're done!
        sessionA.dispose(function (timestamp) {
          this._log.debug("A disposed. Fast-forwarding to " + timestamp);
          this.lastSyncA = timestamp;
          sessionB.dispose(function (timestamp) {
            this._log.debug("B disposed. Fast-forwarding to " + timestamp);
            this.lastSyncB = timestamp;
            callback();
          }.bind(this));
        }.bind(this));
      } else {
        // TODO
      }
    }
    function makeFetchCallback(session) {
      return function (error, record) {
        if (error) {
          this._log.warn("Got error " + Utils.exceptionStr(error) +
                         " fetching.");
          // TODO: handle this.
        }
        session.store(record);
      }.bind(this);
    }

    storeCallbackA = storeCallbackA.bind(this);
    storeCallbackB = storeCallbackB.bind(this);
    makeFetchCallback = makeFetchCallback.bind(this);

    /**
     * We have two sessions. Now we can exchange records between the two.
     */

    function sessionCallbackA(error, sessA) {
      sessionA = sessA;
      //sessionA.timestamp = this.lastSyncA;
      if (error) {
        return callback(error);
      }

      function sessionCallbackB(error, sessB) {
        sessionB = sessB;
        //sessionB.timestamp = this.lastSyncB;
        this._log.info("Timestamps: " + sessionA.timestamp + ", " + sessionB.timestamp);
        if (error) {
          return sessA.dispose(function () {
            callback(error);
          });
        }
        sessionA.fetchSince(this.lastSyncA, makeFetchCallback(sessB));
      }
      this.repositoryB.createSession(storeCallbackB,
                                     sessionCallbackB.bind(this));
    }
    this.repositoryA.createSession(storeCallbackA,
                                   sessionCallbackA.bind(this));
  },

  /**
   * Synchronize. This method blocks execution of the caller. It is deprecated
   * and solely kept for backward-compatibility
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
