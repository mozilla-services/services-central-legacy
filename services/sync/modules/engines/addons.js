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
 * The Initial Developer of the Original Code is the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Gregory Szorc <gps@mozilla.com>
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

/*
 * This file defines the add-on sync functionality.
 *
 * There are currently a number of known limitations:
 *  - We only sync XPI extensions and themes available from addons.mozilla.org.
 *    We hope to expand support for other add-ons eventually.
 *  - We only attempt syncing of add-ons between applications of the same type.
 *    This means add-ons will not synchronize between Firefox desktop and
 *    Firefox mobile, for example. This is because of significant add-on
 *    incompatibility between application types.
 *
 * Add-on records exist for each known {add-on, app-id} pair in the Sync client
 * set. Each record has a randomly chosen GUID. The records then contain
 * basic metadata about the add-on.
 *
 * We currently synchronize:
 *
 *  - Installations
 *  - Uninstallations
 *  - User enabling and disabling
 */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://services-sync/addonsreconciler.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/async.js");

Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/AddonRepository.jsm");

const EXPORTED_SYMBOLS = ["AddonsEngine"];

const ADDON_REPOSITORY_WHITELIST_HOSTNAME = "addons.mozilla.org";

/**
 * AddonRecord represents the state of an add-on in an application.
 *
 * Each add-on has its own record for each application ID it is installed
 * on.
 *
 * The ID of add-on records is a randomly-generated GUID. It is random instead
 * of deterministic so the URIs of the records cannot be guessed and so
 * compromised server credentials won't result in disclosure of the specific
 * add-ons present in a Sync account.
 *
 * The record contains the following fields:
 *
 *  addonID
 *    ID of the add-on. This correlates to the "id" property on an Addon type.
 *
 *  applicationID
 *    The application ID this record is associated with. Clients currently
 *    ignore records from other application IDs.
 *
 *  enabled
 *    Boolean stating whether add-on is enabled or disabled by the user.
 *
 *  deleted
 *    Boolean stating whether the add-on is deleted.
 *
 *  isAddonRepository
 *    Boolean stating whether the add-on is provided by the AddonRepository
 *    API.
 */
function AddonRecord(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
AddonRecord.prototype = {
  __proto__: CryptoWrapper.prototype,
  _logName: "Record.Addon"
};

Utils.deferGetSet(AddonRecord, "cleartext", ["addonID",
                                             "applicationID",
                                             "enabled",
                                             "deleted",
                                             "isAddonRepository"]);

/**
 * The AddonsEngine handles synchronization of add-ons between clients.
 *
 * The engine handles incoming add-ons in one large batch, as it needs
 * to assess the overall state at one time.
 *
 * The engine fires the following notifications (all prefixed with
 * "weave:engine:addons:"):
 *
 *   restart-required  Fired at the tail end of performing a sync when an
 *                     an application restart is required to finish add-on
 *                     processing. The observer receives an array of add-on IDs
 *                     that require restart. Observers should likely wait until
 *                     after the sync is done (signified by reception of the
 *                     "weave:service:sync:finish" event) to actually restart
 *                     or give the user an opportunity to restart.
 */
function AddonsEngine() {
  SyncEngine.call(this, "Addons");

  this._reconciler = new AddonsReconciler();
}
AddonsEngine.prototype = {
  __proto__:              SyncEngine.prototype,
  _storeObj:              AddonsStore,
  _trackerObj:            AddonsTracker,
  _recordObj:             AddonRecord,
  version:                1,

  _reconciler: null,
  _reconciler_state_loaded: false,

  _findDupe: function _findDupe(item) {
    let id = item.addonID;

    let addons = this._reconciler.addons();
    if (!(id in addons)) {
      return null;
    }

    let addon = addons[id];
    if (addon.guid != item.id) {
      return addon.guid;
    }

    return null;
  },

  _syncStartup: function _syncStartup() {
    // We refresh state before calling parent because syncStartup in the parent
    // looks for changed IDs, which is dependent on add-on state being up to
    // date.
    this._log.debug("in syncStartup()");
    if (!this._reconciler_state_loaded) {
      let cb = Async.makeSpinningCallback();
      this._reconciler.loadState(null, cb);
      cb.wait();
      this._reconciler_state_loaded = true;
    }

    let cb = Async.makeSpinningCallback();
    this._reconciler.refreshGlobalState(cb);
    cb.wait();

    // Manually update tracker with changes since last sync.
    let lastDate = new Date(this.lastSync * 1000);
    let changes = this._reconciler.getChangesSinceDate(lastDate);
    let addons = this._reconciler.addons;
    for each (let change in changes) {
      let id = change[2];
      if (!(id in addons)) {
        continue;
      }

      this._log.debug("Adding changed add-on from changes log: " + id);
      let addon = addons[id];
      this._tracker.addChangedID(addon.guid, new Date(change[0]));
    }

    SyncEngine.prototype._syncStartup.call(this);
  },
};

/**
 * This is the primary interface between Sync and the Addons Manager.
 */
function AddonsStore(name) {
  Store.call(this, name);
}
AddonsStore.prototype = {
  __proto__: Store.prototype,

  // Define the add-on types (.type) that we support.
  _syncableTypes: ["extension", "theme"],

  get reconciler() {
    return Engines.get("addons")._reconciler;
  },

  /**
   * Provides core Store API to create/install an add-on from a record.
   */
  create: function create(record) {
    let cb = Async.makeSpinningCallback();
    this.installAddonsFromIDs([record.addonID], cb);
    cb.wait();
  },

  /**
   * Provides core Store API to remove/uninstall an add-on from a record.
   */
  remove: function remove(record) {
    let addon = this.getAddonByID(record.addonID);
    if (!addon) {
      return;
    }

    this._log.debug("Uninstalling add-on: " + addon.id);
    addon.uninstall();

    // This may take a while, so we pause the event loop.
    this._sleep(0);
  },

  update: function update(record) {
    let addon = this.getAddonByID(record.addonID);
    if (!addon) {
      // TODO log error?
      return;
    }

    if (record.enabled == addon.userDisabled) {
      this._log.info("Updating userEnabled flag: " + addon.id);

      addon.userDisabled = !record.enabled;
      this._sleep(0);
    }
  },

  itemExists: function itemExists(guid) {
    let addon = this.reconciler.getAddonStateFromSyncGUID(guid);

    if (!addon) {
      return false;
    }

    return !!addon.installed;
  },

  /**
   * Create an add-on record from its GUID.
   *
   * @param guid
   *        Add-on GUID (from extensions DB)
   * @param collection
   *        Collection to add record to.
   *
   * @return AddonRecord instance
   */
  createRecord: function createRecord(guid, collection) {
    let record = new AddonRecord(collection, guid);
    record.applicationID = Services.appinfo.ID;

    let addon = this.reconciler.getAddonStateFromSyncGUID(guid);

    // If we don't know about this GUID, we assume it has been deleted.
    if (!addon) {
      record.deleted = true;
      return record;
    }

    record.addonID           = addon.id;
    record.enabled           = addon.enabled;
    record.deleted           = false;

    // This needs to be dynamic when add-ons don't come from AddonRepository.
    record.isAddonRepository = true;

    return record;
  },

  /**
   * Changes the id of an add-on.
   *
   * This implements a core API of the store.
   */
  changeItemID: function changeItemID(oldID, newID) {
    let addon = this.getAddonByGUID(oldID);
    if (addon) {
      addon.syncGUID = newID;
    }
  },

  /**
   * Obtain the set of all syncable add-on Sync GUIDs.
   *
   * This implements a core Store API.
   */
  getAllIDs: function getAllIDs() {
    let ids = {};

    let addons = this.reconciler.addons;
    for each (let addon in addons) {
      if (this.isAddonSyncable(addon)) {
        ids[addon.guid] = true;
      }
    }

    return ids;
  },

  /**
   * Wipe engine data.
   *
   * This uninstalls all syncable addons from the application. In case of
   * error, it logs the error and keeps trying with other add-ons.
   */
  wipe: function wipe() {
    for (let id in this.getAllIDs()) {
      let addon = this.getAddonByID(id);
      if (!addon) {
        continue;
      }

      this._log.info("Uninstalling add-on as part of wipe: " + addon.id);
      Utils.catch(addon.uninstall)();
    }
  },

  /***************************************************************************
   * Functions below are unique to this store and not part of the Store API  *
   ***************************************************************************/

  /**
   * Obtain an add-on from its database ID
   *
   * @param id
   *        Add-on ID
   * @return Addon or undefined if not found
   */
  getAddonByID: function getAddonByID(id) {
    let cb = Async.makeSyncCallback();
    AddonManager.getAddonByID(id, cb);
    return Async.waitForSyncCallback(cb);
  },

  /**
   * Obtain an add-on from its database/Sync GUID
   *
   * @param  guid
   *         Add-on Sync GUID
   * @return DBAddonInternal or null
   */
  getAddonByGUID: function getAddonByGUID(guid) {
    let cb = Async.makeSyncCallback();
    AddonManager.getAddonBySyncGUID(guid, cb);
    return Async.waitForSyncCallback(cb);
  },

  /**
   * Determines whether an add-on is suitable for Sync.
   *
   * @param  addon
   *         Addon instance
   * @return Boolean indicating whether it is appropriate for Sync
   */
  isAddonSyncable: function isAddonSyncable(addon) {
    // Currently, we limit syncable add-ons to those that:
    //   1) In a well-defined set of types
    //   2) Installed in current profile
    //   3) Not installed by a foreign entity (i.e. installed by the app)
    //      since they act like global extensions.
    //   4) Are installed from AMO

    //this._log.info("Raw Addon: " + JSON.stringify(addon));

    let syncable = addon &&
                   this._syncableTypes.indexOf(addon.type) != -1 &&
                   addon.scope | AddonManager.SCOPE_PROFILE &&
                   !addon.foreignInstall;

    // We provide a back door to skip the repository checking of an add-on.
    // This is utilized by the tests to make testing easier.
    if (Svc.Prefs.get("addon.ignoreRepositoryChecking", false)) {
      return syncable;
    }

    let cb = Async.makeSyncCallback();
    AddonRepository.getCachedAddonByID(addon.id, cb);
    let result = Async.waitForSyncCallback(cb);

    this._log.info("Cached Result: " + JSON.stringify(result));

    return result && result.sourceURI &&
           result.sourceURI.host == ADDON_REPOSITORY_WHITELIST_HOSTNAME;
  },

  /**
   * Obtain an AddonInstall object from an AddonSearchResult instance.
   *
   * The callback will be invoked with the result of the operation. The
   * callback receives 2 arguments, error and result. Error will be falsey
   * on success or some kind of error value otherwise. The result argument
   * will be an AddonInstall on success or null on failure. It is possible
   * for the error to be falsey but result to be null. This could happen if
   * an install was not found.
   *
   * @param addon
   *        AddonSearchResult to obtain install from.
   * @param cb
   *        Function to be called with result of operation.
   */
  getInstallFromSearchResult: function getInstallFromSearchResult(addon, cb) {
    if (addon.install) {
      cb(null, add.install);
      return;
    }

    this._log.debug("Manually obtaining install for " + addon.id);

    // TODO do we need extra verification on sourceURI source?
    AddonManager.getInstallForURL(
      addon.sourceURI.spec,
      function handleInstall(install) {
        cb(null, install);
      },
      "application/x-xpinstall",
      undefined,
      addon.name,
      addon.iconURL,
      addon.version
    );
  },

  /**
   * Installs an add-on from an AddonSearchResult instance.
   *
   * When complete it calls a callback with 2 arguments, error and result.
   *
   * If error is falesy, result is an object. If error is truthy, result is
   * null.
   *
   * The result object has the following keys:
   *   requiresRestart  Boolean indicating whether install requires restart.
   *
   * @param addon
   *        AddonSearchResult to install add-on from.
   * @param cb
   *        Function to be invoked with result of operation.
   */
  installAddonFromSearchResult:
    function installAddonFromSearchResult(addon, cb) {
    this._log.info("Trying to install add-on from search result: " + addon.id);

    this.getInstallFromSearchResult(addon, function(error, install) {
      if (error) {
        cb(error, null);
        return;
      }

      if (!install) {
        cb("AddonInstall not available: " + addon.id, null);
        return;
      }

      try {
        this._log.info("Installing " + addon.id);

        let restart = addon.operationRequiringRestart &
          AddonManager.OP_NEEDS_RESTART_INSTALL;

        install.install();
        cb(null, {requiresRestart: restart});
      }
      catch (ex) {
        this._log.error("Error installing add-on: " + Utils.exceptionstr(ex));
        cb(ex, null);
      }
    });
  },

  /**
   * Installs multiple add-ons specified by their IDs.
   *
   * The callback will be called when activity on all add-ons is complete. The
   * callback receives 2 arguments, error and result. If error is truthy, it
   * contains an error value and result is null. If it is falsely, result
   * is an object containining additional information on each add-on.
   *
   * @param ids
   *        Array of add-on string IDs to install.
   * @param cb
   *        Function to be called when all actions are complete.
   */
  installAddonsFromIDs: function installAddonsFromIDs(ids, cb) {

    AddonRepository.getAddonsByIDs(ids, {
      searchSucceeded: function searchSucceeded(addons, addonsLength, total) {
        this._log.info("Found " + addonsLength + "/" + ids.length +
                       "add-ons during repository search.");

        let ourResult = {

        };

        if (!addonsLength) {
          cb(null, ourResult);
          return;
        }

        let finishedCount = 0;
        let installCallback = function installCallback(error, result) {
          finishedCount++;

          if (finishedCount >= addonsLength) {
            cb(null, ourResult);
          }
        }.bind(this);

        for (let i = 0; i < addonsLength; i++) {
          this.installAddonFromSearchResult(addons[i], installCallback);
        }

      }.bind(this),

      searchFailed: function searchFailed() {
        cb("AddonRepository search failed", null);
      }.bind(this)
    });
  }
};

function AddonsTracker(name) {
  Tracker.call(this, name);

  Svc.Obs.add("weave:engine:start-tracking", this);
  Svc.Obs.add("weave:engine:stop-tracking", this);
}
AddonsTracker.prototype = {
  __proto__: Tracker.prototype,

  get reconciler() {
    return Engines.get("addons")._reconciler;
  },

  get store() {
    return Engines.get("addons")._store;
  },

  /**
   * This callback is executed whenever the AddonsReconciler sends out a change
   * notification. See AddonsReconciler.addChangeListener().
   */
  changeListener: function changeHandler(date, change, addon) {
    if (!this.store.isAddonSyncable(addon)) {
      return;
    }

    this.addChangedID(addon.guid, date.getTime() / 1000);
    this.score += SCORE_INCREMENT_XLARGE;
  },

  observe: function(subject, topic, data) {
    switch (topic) {
      case "weave:engine:start-tracking":
        this.reconciler.addChangeListener(this);
        break;

      case "weave:engine:stop-tracking":
        this.reconciler.removeChangeListener(this);
        break;
    }
  }
};
