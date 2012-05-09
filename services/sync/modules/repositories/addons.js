/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["AddonsRepositorySession"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://services-sync/addonsreconciler.js");
Cu.import("resource://services-sync/repository.js");

function AddonsRepository() {
  this._reconciler = new AddonsReconciler();
}
AddonsRepository.prototype = {
  __proto__: Repository.prototype,
};

function AddonsRepositorySession(repository, cb) {

  RepositorySession.call(this, repository, cb);
}
AddonsRepositorySession.prototype = {
  __proto__: RepositorySession.prototype,

  guidsSince: function guidsSince(time, cb) {
    let changes = this._reconciler.getChangesSinceDate(time);

    let ids = {};
    for each (let [date, type, id] in changes) {
      ids[id] = true;
    }

    cb(null, Object.keys(ids));
  },

  fetchSince: function fetchSince(time, cb) {
    this.guidsSince(time, function onGUIDs(error, guids) {
      this.fetch(guids, cb);
    }.bind(this));
  },

  fetch: function fetch(guids, cb) {
    for each (let guid in guids) {
      this.fetchByGUID(guid, cb);
    }

    cb(null, this.DONE);
  },

  fetchByGUID: function fetchByGUID(guid, cb) {
    let record = {};
    record.applicationID = Services.appinfo.ID;

    let addon = this._reconciler.getAddonsFromSyncGUID(guid);

    if (!addons || !addons.installed) {
      record.deleted = true;

      cb(null, record);
      return;
    }

    record.modified = addons.modified.getTime();
    record.addonID = addon.id;
    record.enabled = addon.enabled;

    record.source = "amo";

    cb(null, record);
  },

  store: function store(record) {
    if (record == this.DONE) {
      this.storeCallback(this.DONE);
      return;
    }

    if (record.deleted) {
      this.uninstallByGUID(record.id);
      return;
    }

    // Ignore records not belonging to our application ID because that is the
    // current policy.
    if (record.applicationID != Services.appinfo.ID) {
      this._log.info("Ignoring incoming record from other App ID: " +
                     record.id);

      this.storeCallback(null);
      return;
    }

    // We only currently know how to deal with records from the official add-on
    // repository.
    if (record.source != "amo") {
      this._log.info("Ignoring unknown add-on source (" + record.source + ")" +
                     " for " + record.id);
      this.storeCallback(null);
      return;
    }

    if (this.guidExists(record.id)) {
      this.installAddon
    }
  },

  guidExists: function guidExists(guid) {
    return guid in this.reconciler.getAllSyncGUIDs();
  },

  /**
   * Helper function to install an add-on from its public ID.
   */
  installAddonByID: function installAddonByID(id, guid, enabled, cb) {
    AddonRepository.getAddonsByIDs([id], {
      searchSucceeded: function searchSucceeded(addons, addonsLength, total) {
        if (!addonsLength) {
          cb("add-on not found.");
          return;
        }

        let addon = addons[0];
        // TODO.
      },
      searchFailed: function searchFailed() {
        cb(new Error("AddonRepository search failed."));
      },
    });
  },

  installAddonFromSearch: function installAddonFromSearch(addon, cb) {
    // Rewrite the "src" query string parameter of the source URI to note that
    // the add-on was installed by Sync and not something else so server-side
    // metrics aren't skewed (bug 708134). The server should ideally send proper
    // URLs, but this solution was deemed too complicated at the time this
    // functionality was implemented.
    if (!addon.sourceURI) {
      // TODO is this right?
      cb();
      return;
    }

    try {
      addon.sourceURI.QueryInterface(Ci.nsIURL);
    } catch (ex) {
      this._log.warn("Unable to QI sourceURI to nsIURL: " +
                     addon.sourceURI.spec);
      cb();
      return;
    }

    let params = addon.sourceURI.query.split("&").map(function rewrite(param) {
      if (param.indexOf("src=") == 0) {
        return "src=sync";
      } else {
        return param;
      }
    });

    addon.sourceURI.query = params.join("&");

    cb(new Error("Functionality not yet implemented."));
  },

  uninstallByGUID: function uninstallByGUID(guid) {
    AddonManager.getAddonBySyncGUID(guid, function onAddon(addon) {
      if (!addon) {
        this.storeCallback(null);
        return;
      }

      try {
        addon.uninstall();
      } catch (ex) {
        // TODO log
        let error = new Error("Add-on could not be uninstalled.");
        error.guids = [guid];
        error.info = ex;

        cb(error);
        return;
      }
    }.bind(this));
  },

  wipe: function wipe(cb) {
    this.guidsSince(0, this.onWipeGUIDs.bind(this, cb));
  },

  onWipeGUIDs: function onWipeGUIDs(cb, error, guids) {
    let pending = {};

    function gatedFinish() {
      if (Object.keys(pending).length) {
        return;
      }

      cb(null);
    }

    for each (let guid in guids) {
      pending[guid] = true;
      AddonManager.getAddonBySyncGUID(guid, function onAddon(addon) {
        try {
          addon.uninstall();
        } catch (ex) {
          // TODO log
        } finally {
          delete pending[guid];

          gatedFinish();
        }
      });
    }
  },
};
