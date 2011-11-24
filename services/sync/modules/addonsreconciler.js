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

/**
 * This file contains middleware to reconcile state of AddonManager for
 * purposes of tracking events for Sync. The content in this file exists
 * because AddonManager does not have a getChangesSinceX() API and adding
 * that functionality properly was deemed too time-consuming at the time
 * add-on sync was originally written. If/when AddonManager adds this API,
 * this file can go away and the add-ons engine can be rewritten to use it.
 *
 * It was decided to have this tracking functionality exist in a separate
 * standalone file so it could be more easily understood, tested, and
 * hopefully ported.
 */

"use strict";

const {Cc: classes, Ci: interfaces, Cu: utils} = Components;

Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://gre/modules/AddonManager.jsm");

const EXPORTED_SYMBOLS = ["AddonsReconciler"];

const DEFAULT_STATE_FILE = "addonsreconciler";

/**
 * Maintains state of add-ons.
 *
 * The AddonsReconciler is installed as an AddonManager listener. When it
 * receives change notifications, it updates its internal state database.
 *
 * The internal state is persisted to a JSON file in the profile directory.
 *
 * An instance of this is bound to an AddonsEngine instance. In reality, it
 * likely exists as a singleton. To AddonsEngine, it functions as a store and
 * an entity which emits events for tracking.
 *
 * The usage pattern for instances of this class is:
 *
 *   let reconciler = new AddonsReconciler();
 *   reconciler.loadFile(null, function(error) { ... });
 *
 *   // Wait for loadFile callback to run.
 *   reconciler.processStartupChanges(function(error) { ... });
 *
 *   // At this point, your instance should be ready to use.
 */
function AddonsReconciler() {
  this._log = Log4Moz.repository.getLogger("Sync.AddonsReconciler");
  let level = Svc.Prefs.get("log.logger.addonsreconciler", "Debug");
  this._log.level = Log4Moz.Level[level];

  Svc.Obs.add("weave:engine:start-tracking", this);
  Svc.Obs.add("weave:engine:stop-tracking", this);
};
AddonsReconciler.prototype = {
  /** Flag indicating whether we are listening to AddonManager events. */
  _listening: false,

  /** Flag indicating whether we have queried AddonManager startup changes. */
  _startupQueried: false,

  /** log4moz logger instance */
  _log: null,

  /**
   * This is the main data structure for an instance.
   *
   * Keys are add-on IDs. Values are objects which describe the state of the
   * add-on.
   */
  _addons: {},

  /**
   * Loads reconciler state from a file.
   *
   * The path is relative to the weave directory in the profile. If no
   * path is given, the default one is used.
   *
   * @param path
   *        Path to load. ".json" is appended automatically.
   * @param cb
   *        Callback to be executed upon file load. The callback receives a
   *        single truthy argument signifying whether an error occurred.
   */
  loadFile: function loadFile(path, callback) {
    Utils.jsonLoad(path || DEFAULT_STATE_FILE, this, function(json) {
      if (json != undefined) {
        this._addons = json;
        if (callback) {
          callback(false);
        }
      }
      else {
        this._addons = {};
        if (callback) {
          callback(true);
        }
      }
    });
  }

  saveFile: function saveFile(path, callback) {
    Utils.jsonSave(path || DEFAULT_STATE_FILE, this, this._addons, callback);
  }

  /**
   * Generic observer callback that reacts to external events.
   */
  observe: function(subject, topic, data) {
    switch (topic) {
      case "weave:engine:start-tracking":
        if (!this._listening) {
          this._listening = true;
          AddonManager.addAddonListener(this);
          AddonManager.addInstallListener(this);
        }
        break;

      case "weave:engine:stop-tracking":
        if (this._listening) {
          AddonManager.removeInstallListener(this);
          AddonManager.removeAddonListener(this);
          this._listening = false;
        }
        break;
    }
  },

  /**
   * Process an add-on change event.
   *
   * This receives arguments describing a change. That change is applied to the
   * local data so the local data reflects the new state of the world.
   */
  processChange: function processChange(action, metadata) {

  },

  /**
   * Obtains changes made during startup and reconciles them.
   *
   * It only needs to be called once during the lifetime of the reconciler
   * because startup changes are static.
   *
   * It is worth explicitly calling out that startup changes are changes made
   * to the Addons Manager performed at application startup because the
   * encountered state differed from what was in the providers. Startup changes
   * are not changes to non-restartless add-ons, for example. This is a subtle
   * but very important distinction!
   */
  _reconcileStartupChanges: function _reconcileStartupChanges() {
    this._log.debug("Obtaining add-ons modified on application startup");

    this._startupQueried = true;
    let changes = AddonManager.getAllStartupChanges();

    if (!Object.keys(changes).length) {
      this._log.info("No add-on changes on application startup detected.");
      return;
    }

    let changedIDs = {};
    for (let [type, ids] in Iterator(changes)) {
      switch (type) {
        case AddonManager.STARTUP_CHANGE_INSTALLED:

        case AddonManager.STARTUP_CHANGE_CHANGED:

        case AddonManager.STARTUP_CHANGE_UNINSTALLED:

        case AddonManager.STARTUP_CHANGE_DISABLED:

        case AddonManager.STARTUP_CHANGE_ENABLED:

        default:
          this._log.error("Unhandled startup change detected: " + type);


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

  },


  // AddonListeners
  onEnabling: function onEnabling(addon, requiresRestart) {
    this._handleListener("onEnabling", addon, requiresRestart);
  },
  onEnabled: function onEnabled(addon) {
    this._handleListener("onEnabled", addon);
  },
  onDisabling: function onDisabling(addon, requiresRestart) {
    this._handleListener("onDisabling", addon, requiresRestart);
  },
  onDisabled: function onDisabled(addon) {
    this._handleListener("onDisabled", addon);
  },
  onInstalling: function onInstalling(addon, requiresRestart) {
    this._handleListener("onInstalling", addon, requiresRestart);
  },
  onInstalled: function onInstalled(addon) {
    this._handleListener("onInstalled", addon);
  },
  onUninstalling: function onUninstalling(addon, requiresRestart) {
    this._handleListener("onUninstalling", addon, requiresRestart);
  },
  onUninstalled: function onUninstalled(addon) {
    this._handleListener("onUninstalled", addon);
  },
  onOperationCancelled: function onOperationCancelled(addon) {
    this._handleListener("onOperationCancelled", addon);
  },

  // InstallListeners
  onInstallEnded: function onInstallEnded(install, addon) {
    this._handleListener("onInstallEnded", addon);
  }
};
