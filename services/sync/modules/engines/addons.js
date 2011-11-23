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
 *   Gregory Szorc <gps@mozilla.com>
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

// TODO need TPS unit tests
// TODO need unit tests for installing (requires stubbed-out AMO)
// TODO need test for incompatible add-ons

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

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
 * AddonsRec represents the state of an add-on in an application.
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
 *  userEnabled
 *    Boolean stating whether add-on is enabled or disabled by the user.
 *
 *  deleted
 *    Boolean stating whether the add-on is deleted.
 *
 *  isAddonRepository
 *    Boolean stating whether the add-on is provided by the AddonRepository
 *    API.
 */
function AddonsRec(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
AddonsRec.prototype = {
  __proto__: CryptoWrapper.prototype,
  _logName: "Record.Addons"
};

Utils.deferGetSet(AddonsRec, "cleartext", ["addonID",
                                           "applicationID",
                                           "userEnabled",
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

  // This assumes that the engine is instantiated at most once in each app.
  // If this ever changes, this will yield duplicate change records.
  Utils.nextTick(function() {
    this._tracker._trackStartupChanges(this._store);
  }, this);
}
AddonsEngine.prototype = {
  __proto__:              SyncEngine.prototype,
  _storeObj:              AddonsStore,
  _trackerObj:            AddonsTracker,
  _recordObj:             AddonsRec,
  version:                1,
  applyIncomingBatchSize: ADDONS_STORE_BATCH_SIZE
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

  /**
   * Obtain the set of all known records IDs
   */
  getAllIDs: function getAllIDs() {
    let addons = this._getAddons();
    let allids = {};

    for (let i = 0; i < addons.length; i++) {
      allids[addons[i].syncGUID] = true;
    };

    return allids;
  },

  /**
   * Create an add-on record from its GUID.
   *
   * @param guid
   *        Add-on GUID (from extensions DB)
   * @param collection
   *        Collection to add record to.
   *
   * @return AddonsRec instance
   */
  createRecord: function createRecord(guid, collection) {
    let record = new AddonsRec(collection, guid);
    record.applicationID = Services.appinfo.ID;

    let addon = this._getAddonFromGUID(guid);

    // If we don't know about this GUID, we assume it has been deleted.
    if (!addon) {
      record.deleted = true;
      return record;
    }

    record.addonID           = addon.id;
    record.applicationID     = Services.appinfo.ID;
    record.userEnabled       = !addon.userDisabled;
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
    let addon = this._getAddonFromGUID(oldID);
    if (addon) {
      addon.syncGUID = newID;
    }
  },

  /**
   * Determine whether an add-on with the specified ID exists
   */
  itemExists: function itemExists(syncGUID) {
    return (this._getAddonFromGUID(syncGUID) != undefined);
  },

  /**
   * Wipe engine data.
   *
   * This uninstalls all syncable addons from the application. In case of
   * error, it logs the error and keeps trying with other add-ons.
   */
  wipe: function wipe() {
    let requiresRestart = [];

    let addons = this._getAddons();
    let length = addons.length;
    for (let i = 0; i < length; i++) {
      let addon = addons[i];

      if (addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_UNINSTALL) {
        requiresRestart.push(addon.id);
      }

      this._log.info("Uninstalling add-on as part of wipe: " + addon.id);
      Utils.catch(addon.uninstall)();
    }

    if (requiresRestart.length) {
      this._notify("addons:restart-required", requiresRestart);
    }
  },

  /**
   * Obtain the locally-installed, visible add-ons in the current profile.
   *
   * @return Array of DBAddonInternal
   */
  _getAddons: function _getAddons() {
    let cb = Async.makeSyncCallback();
    AddonManager.getAllAddons(cb);
    let result = Async.waitForSyncCallback(cb);

    return result.filter(this.isAddonSyncable, this);
  },

  /**
   * Obtain an add-on from its database ID
   *
   * @param id
   *        Add-on ID (from the extensions DB)
   * @return DBAddonInternal or undefined if not found
   */
  _getAddonFromId: function _getAddonFromId(id) {
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
  _getAddonFromGUID: function _getAddonFromGUID(guid) {
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
  },

  /**
   * Applies all incoming record changes to the local client.
   *
   * The logic for applying incoming records is split up into two phases:
   *
   *  1. Collect all needed changes for incoming records
   *  2. Apply them
   *
   * It is written this way to make the logic clearer and to make testing
   * easier.
   *
   * @param records
   *        Array of AddonsRec to apply.
   */
  applyIncomingBatch: function applyIncomingBatch(records) {
    let addons = {};
    this._getAddons().forEach(function(addon) {
      addons[addon.id] = addon;
    });

    let changes = this._assembleChangesFromRecords(records, addons);
    return this._applyChanges(changes, addons);
  },

  /**
   * Assembles changes to be applied for a set of records.
   *
   * This takes an array of records (presumably those passed into
   * applyIncomingBatch) and ascertains what changes need to happen.
   *
   * @param  records
   *         Array of records to process
   * @param  addons
   *         Array of locally-installed add-ons. If not defined, will be
   *         populated automatically.
   * @return Object describing changes that need to be applied
   */
  _assembleChangesFromRecords:
    function _assembleChangesFromRecords(records, addons) {

    if (addons === undefined) {
      addons = {};
      this._getAddons().forEach(function(addon) {
        addons[addon.id] = addon;
      });
    }

    // Some of these are used as sets (because no set type).
    let uninstall_ids = {}; // add-on ID -> true
    let updated_guids = {}; // add-on ID -> new GUID
    let install_ids   = {}; // add-on ID -> GUID
    let enable_ids    = {}; // add-on ID -> true
    let disable_ids   = {}; // add-on ID -> true

    // Examine each incoming record and record actions that need to be
    // taken. It is important that this actual loop not do anything too
    // expensive, as it executes synchronously to the event loop.
    for each (let record in records) {
      let guid = record.id;
      let id = record.addonID;

      let addon = addons[id];

      // We always overwrite the local add-on GUID with the remote one
      // if they are different. Local GUIDs should exist, as they are
      // created automagically when add-ons are inserted into the database.
      if (addon && addon.syncGUID != guid) {
        updated_guids[id] = guid;
      }

      // Now move on to real add-on management tasks.

      // Ignore records for other application types because we don't care
      // about them at this time.
      if (record.applicationID != Services.appinfo.ID) {
        continue;
      }

      // Remote deletion results in local deletion.
      if (record.deleted) {
        if (addon) {
          uninstall_ids[id] = true;
        } else {
          this._log.debug("Addon " + id + " is not installed locally. "
                          + "Ignoring delete request");
        }

        continue;
      }

      // If we don't have this add-on locally, we mark it for install.
      if (!addon) {
        this._log.debug("Marking add-on for install: " + id);
        install_ids[id] = guid;
        continue;
      }

      // Catch enable/disable actions.
      if (!record.userEnabled && !addon.userDisabled) {
        this._log.debug("Marking add-on for disabling: " + id);
        disable_ids[id] = true;
        continue;
      }

      if (record.userEnabled && addon.userDisabled) {
        this._log.debug("Marking add-on for enabling: " + id);
        enable_ids[id] = true;
        continue;
      }

      // If we get here, it should mean that the modified time and only the
      // modified time was the thing that changed. If it isn't, we have a bug.
    }

    // After we've collected all changes, we reconcile this list to eliminate
    // redundancies.

    // Uninstall requests take priority over all others.
    for (let id in uninstall_ids) {
      delete install_ids[id];
      delete enable_ids[id];
      delete disable_ids[id];
      delete updated_guids[id];
    }

    return {
      guid:      updated_guids,
      uninstall: uninstall_ids,
      install:   install_ids,
      enable:    enable_ids,
      disable:   disable_ids
    };
  },

  /**
   * Applies assembled record changes.
   *
   * This function takes the output of _assembleChangesFromRecords() and turns
   * it into application changes.
   *
   * @param  changes
   *         Object describing changes that need to be made
   * @param  addons
   *         Array of locally-installed add-ons. If not defined, will be
   *         populated automatically.
   *         addons
   */
  _applyChanges: function _applyChanges(changes, addons) {
    if (addons === undefined) {
      addons = {};
      this._getAddons().forEach(function(addon) {
        addons[addon.id] = addon;
      });
    }

    // _assembleChangesFromRecords() ensures that all requested changes aren't
    // in a state of conflict. So, it should be safe to attempt any change
    // operation in any order. That being said, we start with the changes least
    // likely to cause errors just so we error on the side of getting as much
    // done as possible.
    //
    // Addon APIs are not asynchronous. Since we can't work around the issue,
    // we spin the event loop after each operation.

    // GUID changes are pretty cheap, so we start with them.
    // Unfortunately, their API is synchronous.
    for (let [id, guid] in Iterator(changes.guid)) {
      let addon = addons[id];
      this._log.debug("Updating GUID: " + addon.syncGUID + " -> " + guid);
      addon.syncGUID = guid;
      this._sleep(0);
    }

    let requiresRestart = {};

    // Enabling and disabling is the next least-likely to fail.
    for (let id in changes.enable) {
      let addon = addons[id];

      if (addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_ENABLE) {
        requiresRestart[id] = true;
      }

      addon.userDisabled = false;
      this._sleep(0);
    }

    for (let id in changes.disable) {
      let addon = addons[id];

      if (addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_DISABLE) {
        requiresRestart[id] = true;
      }

      addon.userDisabled = true;
      this._sleep(0);
    }

    // Uninstall removed add-ons.
    for (let id in changes.uninstall) {
      let addon = addons[id];

      this._log.debug("Uninstalling addon: " + addon.id);

      if (addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_UNINSTALL) {
        requiresRestart[id] = true;
      }

      addon.uninstall();
      this._sleep(0);
    }

    let failedIDs   = [];
    let failedGUIDs = [];

    // Finally, we install add-ons.
    // We will eventually want to install add-ons that are not on AMO. Until
    // then, we search for an add-on using its registered channels and hope
    // to find something.
    let install_ids = Object.keys(changes.install);
    if (install_ids.length) {

      let cb = Async.makeSpinningCallback();
      this.installAddonsFromIDs(install_ids, cb);
      cb.wait();
    }

    if (requiresRestart.length) {
      this._notify("addons:restart-required", Object.keys(requiresRestart));
    }

    return failedGUIDs;
  }
};


/**
 * The following are callbacks registered with the AddonManager.
 *
 * We have 2 listeners: AddonListener and InstallListener. We are a listener
 * for both.
 *
 * When an add-on is installed, listeners are called in the following order:
 *
 *  IL.onInstallStarted, AL.onInstalling, IL.onInstallEnded, AL.onInstalled
 *
 * For non-restartless add-ons, an application restart may occur between
 * IL.onInstallEnded and AL.onInstalled. Unfortunately, Sync likely will
 * not be lodaded when AL.onInstalled is fired shortly after application
 * start, so it won't see this event. Therefore, for add-ons requiring a
 * restart, Sync treats the IL.onInstallEnded event as good enough to
 * denote an install. For restartless add-ons, Sync assumes AL.onInstalled
 * will follow shortly after IL.onInstallEnded and thus is ignores
 * IL.onInstallEnded.
 *
 * For uninstalls, we see AL.onUninstalling then AL.onUninstalled. Like
 * installs, the events could be separated by an application restart and Sync
 * may not see the onUninstalled event. Again, if we require a restart, we
 * react to onUninstalling. If not, we assume we'll get onUninstalled.
 *
 * Enabling and disabling work by sending:
 *
 *   AL.onEnabling, AL.onEnabled
 *   AL.onDisabling, AL.onDisabled
 *
 * Again, they may be separated by a restart, so we heed the requiresRestart
 * flag.
 *
 * Actions can be undone. All undoable actions notify the same
 * AL.onOperationCancelled event. We treat this event like any other.
 *
 * Restartless add-ons have interesting behavior during uninstall. These
 * add-ons are first disabled then they are actually uninstalled. So, the
 * tracker will see onDisabling and onDisabled. The onUninstalling and
 * onUninstalled events only come after the Addon Manager is closed or another
 * view is switched to.
 */
function AddonsTracker(name) {
  Tracker.call(this, name);
  Svc.Obs.add("weave:engine:start-tracking", this);
  Svc.Obs.add("weave:engine:stop-tracking", this);
}
AddonsTracker.prototype = {
  __proto__: Tracker.prototype,

  _enabled: false,
  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      case "weave:engine:start-tracking":
        if (!this._enabled) {
          this._enabled = true;
          AddonManager.addAddonListener(this);
          AddonManager.addInstallListener(this);
        }
        break;
      case "weave:engine:stop-tracking":
        if (this._enabled) {
          this._enabled = false;
          AddonManager.removeAddonListener(this);
          AddonManager.removeInstallListener(this);
        }
        break;
    }
  },

  /**
   * Obtains changes made during startup and adds them to the tracker.
   *
   * This is typically called when the engine first starts upon application
   * start-up. It only needs to be called once during the lifetime of the
   * application.
   */
  _trackStartupChanges: function _trackStartupChanges(store) {
    this._log.debug("Obtaining add-ons modified on application startup");

    let changes = AddonManager.getAllStartupChanges();
    // TODO remove next line before landing
    this._log.debug("All startup changes: " + JSON.stringify(changes));

    if (!Object.keys(changes).length) {
      this._log.info("No add-on changes on application startup detected.");
      return;
    }

    let changedIDs = {};
    for (let [type, ids] in Iterator(changes)) {
      // TODO handle uninstall case properly. Currently, we don't have the
      // syncGUID of uninstalled add-ons. Bug 702819 tracks.
      if (type == AddonManager.STARTUP_CHANGE_UNINSTALLED) {
        for each (let id in ids) {
          this._log.warn("Unable to track uninstall: " + id);
        }

        continue;
      }

      for each (let id in ids) {
        changedIDs[id] = true;
      }
    }

    let updated = false;

    let cb = Async.makeSyncCallback();
    AddonManager.getAddonsByIDs(Object.keys(changedIDs), cb);
    let addons = Async.waitForSyncCallback(cb);

    for each (let addon in addons) {
      delete changedIDs[addon.id];

      if (!store.isAddonSyncable(addon)) {
        this._log.debug(
          "Ignoring startup add-on change for unsyncable add-on: " + addon.id);
      } else {
        this._log.debug("Tracking add-on change from startup: " + addon.id);
        this.addChangedID(addon.syncGUID);
        updated = true;
      }
    }

    // We shouldn't have any IDs left. If we do, then something weird is going
    // on. That corner case should be addressed before we get here.
    for each (let id in Object.keys(changedIDs)) {
      this._log.error("Addon changed on startup not present in Addon " +
                      "Manager: " + id);
    }

    if (updated) {
      this.score += SCORE_INCREMENT_XLARGE;
    }
  },

  /**
   * This is a callback that is invoked by the AddonManager listener.
   */
  _trackAddon: function _trackAddon(addon, action, requiresRestart) {
    // Since this is called as an observer, we explicitly trap errors and
    // log them to ourselves so we don't see errors reported elsewhere.
    try {
      if (this.ignoreAll) {
        this._log.debug(action + " of " + addon.id + " ignored because " +
                        "ignoreall is set.");
        return;
      }

      this._log.debug("Tracked change " + action + " to " + addon.id);

      if (requiresRestart != undefined && !requiresRestart) {
        this._log.debug("Ignoring notification because restartless");
        return;
      }

      let store = Engines.get("addons")._store;
      if (!store.isAddonSyncable(addon)) {
        this._log.debug(
          "Ignoring add-on change because it isn't syncable: " + addon.id);
        return;
      }

      this.addChangedID(addon.syncGUID);
      this.score += SCORE_INCREMENT_XLARGE;
    }
    catch (ex) {
      this._log.warn("Exception: " + Utils.exceptionStr(ex));
    }
  },

  // AddonListeners
  onEnabled: function onEnabled(addon) {
    this._trackAddon(addon, "onEnabled");
  },
  onEnabling: function onEnabling(addon, requiresRestart) {
    this._trackAddon(addon, "onEnabling", requiresRestart);
  },
  onDisabled: function onDisabled(addon) {
    this._trackAddon(addon, "onDisabled");
  },
  onDisabling: function onDisabling(addon, requiresRestart) {
    this._trackAddon(addon, "onDisabling", requiresRestart);
  },
  onInstalled: function onInstalled(addon) {
    this._trackAddon(addon, "onInstalled");
  },
  onOperationCancelled: function onOperationCancelled(addon) {
    this._trackAddon(addon, "onOperationCancelled");
  },
  onUninstalled: function onUninstalled(addon) {
    this._trackAddon(addon, "onUninstalled");
  },
  onUninstalling: function onUninstalling(addon, requiresRestart) {
    this._trackAddon(addon, "onUninstalling", requiresRestart);
  },

  // InstallListeners
  onInstallEnded: function onInstallEnded(install, addon) {
    this._trackAddon(addon, "onInstallEnded");
  }
};
