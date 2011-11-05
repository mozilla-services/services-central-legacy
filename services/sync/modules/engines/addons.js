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
  Utils.nextTick(this._tracker._trackStartupChanges, this);
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
    // Currently, we only support syncing of add-ons in a well-defined set of
    // types and those in the current profile (since add-ons can be installed
    // in multiple locations).
    return addon &&
           this._syncableTypes.indexOf(addon.type) != -1 &&
           addon.scope | AddonManager.SCOPE_PROFILE;
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
        this._log.trace("Marking add-on for install: " + id);
        install_ids[id] = guid;
        continue;
      }

      // Catch enable/disable actions.
      if (record.userEnabled && addon.userDisabled) {
        this._log.trace("Marking add-on for disabling: " + id);
        disable_ids[id] = true;
        continue;
      }

      if (!record.userEnabled && !addon.userDisabled) {
        this._log.trace("Marking add-on for enabling: " + id);
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

    let failedGUIDs = [];

    // Finally, we install add-ons.
    // We will eventually want to install add-ons that are not on AMO. Until
    // then, we search for an add-on using its registered channels and hope
    // to find something.
    let install_ids = Object.keys(changes.install);
    if (install_ids.length) {
      this._log.info("Attempting to install add-ons: " + install_ids);

      let cb = Async.makeSyncCallback();
      AddonRepository.getAddonsByIDs(install_ids, {
        searchSucceeded: cb,
        searchFailed: cb
      }, false);

      // Result will be array of addons on searchSucceeded or undefined on
      // searchFailed.
      let install_addons = Async.waitForSyncCallback(cb);

      if (!install_addons) {
        this._log.debug("Addon repository search failed.");
        // Return the failed GUIDs.
        return [guid for each (guid in changes.install)];
      }

      let length = install_addons.length;
      this._log.info("Found " + length + " add-ons during repository search.");
      for (let i = 0; i < length; i++) {
        let addon = install_addons[i];

        this._log.debug("About to install " + addon.id);

        if (!addon.install) {
          this._log.debug("Could not get install object for " + addon.id);
          failedGUIDs.push(addon.syncGUID);
          continue;
        }

        if (addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_INSTALL) {
          requiresRestart[addon.id] = true;
        }

        // TODO assign proper GUID to new add-on
        this._log.info("Installing " + addon.id);
        addon.install.install();
        this._sleep(0);
      }

      if (failedGUIDs.length) {
        this._log.debug("Could not get installation information for: " + failedGUIDs);
      }
    }

    if (requiresRestart.length) {
      this._notify("addons:restart-required", Object.keys(requiresRestart));
    }

    return failedGUIDs;
  }
};


function AddonsTracker(name) {
  Tracker.call(this, name);
  Svc.Obs.add("weave:engine:start-tracking", this);
  Svc.Obs.add("weave:engine:stop-tracking", this);
}
AddonsTracker.prototype = {
  __proto__: Tracker.prototype,

  _startupChangeTypes: [
    AddonManager.STARTUP_CHANGE_INSTALLED,
    AddonManager.STARTUP_CHANGE_CHANGED,
    AddonManager.STARTUP_CHANGE_UNINSTALLED,
    AddonManager.STARTUP_CHANGE_DISABLED,
    AddonManager.STARTUP_CHANGE_ENABLED
  ],

  _enabled: false,
  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      case "weave:engine:start-tracking":
        if (!this._enabled) {
          this._enabled = true;
          AddonManager.addAddonListener(this);
        }
        break;
      case "weave:engine:stop-tracking":
        if (this._enabled) {
          this._enabled = false;
          AddonManager.removeAddonListener(this);
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
  _trackStartupChanges: function _trackStartupChanges(engine) {
    let ids = {}; // add-on ID to true

    for (let type in this._startupChangeTypes) {
      for each (let id in AddonManager.getStartupChanges(type)) {
        ids[id] = true;
      }
    }

    let updated = false;

    let store = engine._store;

    let cb = Async.makeSyncCallback();
    AddonManager.getAddonsByIDs(Object.keys(ids));
    let addons = Async.waitForSyncCallback(cb);

    for (let addon in addons) {
      if (!store.isAddonSyncable(addon)) {
        continue;
      }

      this._log.debug("Marking add-on as changed from startup: " + addon.id);
      this.addChangedID(addon.syncGUID);
      updated = true;
    }

    if (updated) {
      this.score += SCORE_INCREMENT_XLARGE;
    }
  },

  /**
   * This is a callback that is invoked by the AddonManager listener.
   */
  _trackAddon: function _trackAddon(addon, action, params) {
    this._log.trace(action + " called for " + addon.id);

    let store = Engines.get("addons")._store;
    if (!store.isAddonSyncable(addon)) {
      this._log.trace(
        "Ignoring add-on change because it isn't syncable: " + addon.id);
      return;
    }

    this.addChangedID(addon.syncGUID);
    this.score += SCORE_INCREMENT_XLARGE;
  },

  /**
   * The following are callbacks registered with the AddonManager.
   */
  onEnabled: function onEnabled(addon) {
    this._trackAddon(addon, "onEnabled");
  },
  onDisabled: function onDisabled(addon) {
    this._trackAddon(addon, "onDisabled");
  },
  onInstalled: function onInstalled(addon) {
    this._trackAddon(addon, "onInstalled");
  },
  onUninstalled: function onUninstalled(addon) {
    this._trackAddon(addon, "onUninstalled");
  }
};
