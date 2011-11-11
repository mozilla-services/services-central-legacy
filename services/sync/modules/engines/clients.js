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
 * The Original Code is Weave
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *  Philipp von Weitershausen <philipp@weitershausen.de>
 *  Gregory Szorc <gps@mozilla.com>
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

const EXPORTED_SYMBOLS = ["Clients", "ClientsRec"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/ext/StringBundle.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-sync/main.js");

const CLIENTS_TTL = 1814400; // 21 days
const CLIENTS_TTL_REFRESH = 604800; // 7 days

const TAB_STATE_COLLECTION = "sendtab";

// The length of 21 days matches the TTL of client records. Records are
// deleted after they are fetched by the receiving client, so they shouldn't
// accumulate on the server.
const DEFAULT_TAB_STATE_TTL = 1814400; // 21 days

function ClientsRec(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
ClientsRec.prototype = {
  __proto__: CryptoWrapper.prototype,
  _logName: "Sync.Record.Clients",
  ttl: CLIENTS_TTL
};

Utils.deferGetSet(ClientsRec, "cleartext", ["name", "type", "commands"]);

/**
  * This is the record for individual tab states.
  *
  * It is used by the send tab command. Tab states are stored in their own
  * collection because they could be large and could exhaust space in the
  * clients record.
  */
function SendTabRecord(collection, id) {
  CryptoWrapper.call(this, collection, id);
}
SendTabRecord.prototype = {
  __proto__: CryptoWrapper.prototype,
  _logName:  "Sync.Record.SendTab",
  ttl:       DEFAULT_TAB_STATE_TTL
};
Utils.deferGetSet(SendTabRecord, "cleartext", ["tabState"]);

XPCOMUtils.defineLazyGetter(this, "Clients", function () {
  return new ClientEngine();
});

function ClientEngine() {
  SyncEngine.call(this, "Clients");

  // Reset the client on every startup so that we fetch recent clients
  this._resetClient();
}
ClientEngine.prototype = {
  __proto__: SyncEngine.prototype,
  _storeObj: ClientStore,
  _recordObj: ClientsRec,
  _trackerObj: ClientsTracker,

  // Always sync client data as it controls other sync behavior
  get enabled() true,

  get lastRecordUpload() {
    return Svc.Prefs.get(this.name + ".lastRecordUpload", 0);
  },
  set lastRecordUpload(value) {
    Svc.Prefs.set(this.name + ".lastRecordUpload", Math.floor(value));
  },

  // Aggregate some stats on the composition of clients on this account
  get stats() {
    let stats = {
      hasMobile: this.localType == "mobile",
      names: [this.localName],
      numClients: 1,
    };

    for each (let {name, type} in this._store._remoteClients) {
      stats.hasMobile = stats.hasMobile || type == "mobile";
      stats.names.push(name);
      stats.numClients++;
    }

    return stats;
  },

  get localID() {
    // Generate a random GUID id we don't have one
    let localID = Svc.Prefs.get("client.GUID", "");
    return localID == "" ? this.localID = Utils.makeGUID() : localID;
  },
  set localID(value) Svc.Prefs.set("client.GUID", value),

  get localName() {
    let localName = Svc.Prefs.get("client.name", "");
    if (localName != "")
      return localName;

    // Generate a client name if we don't have a useful one yet
    let env = Cc["@mozilla.org/process/environment;1"]
                .getService(Ci.nsIEnvironment);
    let user = env.get("USER") || env.get("USERNAME") ||
               Svc.Prefs.get("account") || Svc.Prefs.get("username");
    let brand = new StringBundle("chrome://branding/locale/brand.properties");
    let app = brand.get("brandShortName");

    let system = Cc["@mozilla.org/system-info;1"]
                   .getService(Ci.nsIPropertyBag2).get("device") ||
                 Cc["@mozilla.org/network/protocol;1?name=http"]
                   .getService(Ci.nsIHttpProtocolHandler).oscpu;

    return this.localName = Str.sync.get("client.name2", [user, app, system]);
  },
  set localName(value) Svc.Prefs.set("client.name", value),

  get localType() Svc.Prefs.get("client.type", "desktop"),
  set localType(value) Svc.Prefs.set("client.type", value),

  /**
   * Retrieve information about remote clients.
   *
   * Returns an object with client IDs as keys and objects describing each
   * client as values.
   */
  get remoteClients() {
    let ret = {};

    for each (let [id, record] in Iterator(this._store._remoteClients)) {
      ret[id] = record;
    }

    return ret;
  },

  /**
   * Obtain the URL of the tab state collection.
   *
   * @return String
   *         URL to tabstate collection.
   */
  get tabStateURL() {
    return this.storageURL + TAB_STATE_COLLECTION;
  },

  isMobile: function isMobile(id) {
    if (this._store._remoteClients[id])
      return this._store._remoteClients[id].type == "mobile";
    return false;
  },

  _syncStartup: function _syncStartup() {
    // Reupload new client record periodically.
    if (Date.now() / 1000 - this.lastRecordUpload > CLIENTS_TTL_REFRESH) {
      this._tracker.addChangedID(this.localID);
      this.lastRecordUpload = Date.now() / 1000;
    }
    SyncEngine.prototype._syncStartup.call(this);
  },

  // We override the default implementation to additionally upload tab state
  // records.
  _uploadOutgoing: function _uploadOutgoing() {
    // There might be a race condition between us uploading tab state records
    // and another client fetching them during command processing. We upload
    // the tab state records first to avoid this.
    this._uploadSendTabRecords();
    SyncEngine.prototype._uploadOutgoing.call(this);
  },

  _uploadSendTabRecords: function _uploadSendTabRecords() {
    if (!Object.keys(this._store._outgoingSendTabRecords).length) {
      return;
    }

    // This will be invoked with 'this' bound to the engine.
    let getTabRecord = function(id) {
      let record = new SendTabRecord(id, TAB_STATE_COLLECTION);
      let entry = this._store._outgoingSendTabRecords[id];

      record.id       = id;
      record.ttl      = entry.ttl;
      record.tabState = entry.state;

      return record;
    };

    // The value of lastSync is irrelevant.
    let result = this._uploadOutgoingRecords(
      Object.keys(this._store._outgoingSendTabRecords),
      this.tabStateURL,
      this.lastSync,
      getTabRecord
    );

    // Technically we should only wipe out records which were successfully
    // uploaded. But with tab state, we have one shot at it. If it doesn't
    // work, we move forward. That being said, we never get this far on many
    // errors because the upload error will throw which will abort sync of the
    // engine. In the case of an aborted sync, we'll simply try again on the
    // next sync. In the event we actually get here, we'll still send a
    // command but the state record won't exist and the receiver will fall
    // back to simple "display a URI" behavior.
    this._store._outgoingSendTabRecords = {};
  },

  // Always process incoming items because they might have commands.
  _reconcile: function _reconcile() {
    return true;
  },

  // Treat reset the same as wiping for locally cached clients
  _resetClient: function _resetClient() this._wipeClient(),

  _wipeClient: function _wipeClient() {
    SyncEngine.prototype._resetClient.call(this);
    this._store.wipe();
  },

  removeClientData: function removeClientData() {
    let res = new Resource(this.engineURL + "/" + this.localID);
    res.delete();
  },

  // Override the default behavior to delete bad records from the server.
  handleHMACMismatch: function handleHMACMismatch(item, mayRetry) {
    this._log.debug("Handling HMAC mismatch for " + item.id);

    let base = SyncEngine.prototype.handleHMACMismatch.call(this, item, mayRetry);
    if (base != SyncEngine.kRecoveryStrategy.error)
      return base;

    // It's a bad client record. Save it to be deleted at the end of the sync.
    this._log.debug("Bad client record detected. Scheduling for deletion.");
    this._deleteId(item.id);

    // Neither try again nor error; we're going to delete it.
    return SyncEngine.kRecoveryStrategy.ignore;
  },

  /**
   * A hash of valid commands that the client knows about. The key is a command
   * and the value is a hash containing information about the command such as
   * number of arguments and description.
   */
  _commands: {
    resetAll:    { args: 0, desc: "Clear temporary local data for all engines" },
    resetEngine: { args: 1, desc: "Clear temporary local data for engine" },
    wipeAll:     { args: 0, desc: "Delete all client data for all engines" },
    wipeEngine:  { args: 1, desc: "Delete all client data for engine" },
    logout:      { args: 0, desc: "Log out client" },
    displayURI:  { args: 2, desc: "Instruct a client to display a URI" },
    displayTab:  { args: 1, desc: "Instruct a client to display a tab" }
  },

  /**
   * Remove any commands for the local client and mark it for upload.
   */
  clearCommands: function clearCommands() {
    delete this.localCommands;
    this._tracker.addChangedID(this.localID);
  },

  /**
   * Sends a command+args pair to a specific client.
   *
   * @param command Command string
   * @param args Array of arguments/data for command
   * @param clientId Client to send command to
   */
  _sendCommandToClient: function sendCommandToClient(command, args, clientId) {
    this._log.trace("Sending " + command + " to " + clientId);

    let client = this._store._remoteClients[clientId];
    if (!client) {
      throw new Error("Unknown remote client ID: '" + clientId + "'.");
    }

    // notDupe compares two commands and returns if they are not equal.
    let notDupe = function(other) {
      return other.command != command || !Utils.deepEquals(other.args, args);
    };

    let action = {
      command: command,
      args: args,
    };

    if (!client.commands) {
      client.commands = [action];
    }
    // Add the new action if there are no duplicates.
    else if (client.commands.every(notDupe)) {
      client.commands.push(action);
    }
    // It must be a dupe. Skip.
    else {
      return;
    }

    this._log.trace("Client " + clientId + " got a new action: " + [command, args]);
    this._tracker.addChangedID(clientId);
  },

  /**
   * Check if the local client has any remote commands and perform them.
   *
   * @return false to abort sync
   */
  processIncomingCommands: function processIncomingCommands() {
    return this._notify("clients:process-commands", "", function() {
      let commands = this.localCommands;

      // Immediately clear out the commands as we've got them locally.
      this.clearCommands();

      // Process each command in order.
      for each ({command: command, args: args} in commands) {
        this._log.debug("Processing command: " + command + "(" + args + ")");

        let engines = [args[0]];
        switch (command) {
          case "resetAll":
            engines = null;
            // Fallthrough
          case "resetEngine":
            Weave.Service.resetClient(engines);
            break;
          case "wipeAll":
            engines = null;
            // Fallthrough
          case "wipeEngine":
            Weave.Service.wipeClient(engines);
            break;
          case "logout":
            Weave.Service.logout();
            return false;
          case "displayURI":
            this._handleDisplayURI(args[0], args[1]);
            break;
          case "displayTab":
            this._handleDisplayTab(args[0]);
            break;
          default:
            this._log.debug("Received an unknown command: " + command);
            break;
        }
      }

      return true;
    })();
  },

  /**
   * Validates and sends a command to a client or all clients.
   *
   * Calling this does not actually sync the command data to the server. If the
   * client already has the command/args pair, it won't receive a duplicate
   * command.
   *
   * @param command
   *        Command to invoke on remote clients
   * @param args
   *        Array of arguments to give to the command
   * @param clientId
   *        Client ID to send command to. If undefined, send to all remote
   *        clients.
   */
  sendCommand: function sendCommand(command, args, clientId) {
    let commandData = this._commands[command];
    // Don't send commands that we don't know about.
    if (!commandData) {
      this._log.error("Unknown command to send: " + command);
      return;
    }
    // Don't send a command with the wrong number of arguments.
    else if (!args || args.length != commandData.args) {
      this._log.error("Expected " + commandData.args + " args for '" +
                      command + "', but got " + args);
      return;
    }

    if (clientId) {
      this._sendCommandToClient(command, args, clientId);
    } else {
      for (let id in this._store._remoteClients) {
        this._sendCommandToClient(command, args, id);
      }
    }
  },

  /**
   * Send a URI to another client for display.
   *
   * A side effect is the score is increased dramatically to incur an
   * immediate sync.
   *
   * If an unknown client ID is specified, sendCommand() will throw an
   * Error object.
   *
   * @param uri
   *        URI (as a string) to send and display on the remote client
   * @param clientId
   *        ID of client to send the command to. If not defined, will be sent
   *        to all remote clients.
   */
  sendURIToClientForDisplay: function sendURIToClientForDisplay(uri, clientId) {
    this._log.info("Sending URI to client: " + uri + " -> " + clientId);
    this.sendCommand("displayURI", [uri, this.syncID], clientId);

    Clients._tracker.score += SCORE_INCREMENT_XLARGE;
  },

  /**
   * Handle a single received 'displayURI' command.
   *
   * Interested parties should observe the "weave:engine:clients:display-uri"
   * topic. The callback will receive an object as the subject parameter with
   * the following keys:
   *
   *   uri       URI (string) that is requested for display
   *   clientId  ID of client that sent the command
   *
   * The 'data' parameter to the callback will not be defined.
   *
   * @param uri
   *        String URI that was received
   * @param clientId
   *        ID of client that sent URI
   */
  _handleDisplayURI: function _handleDisplayURI(uri, clientId) {
    this._log.info("Received a URI for display: " + uri + " from " + clientId);

    let subject = { uri: uri, client: clientId };
    Svc.Obs.notify("weave:engine:clients:display-uri", subject);
  },

  /**
   * Sends a tab to another client.
   *
   * This can be thought of as a more powerful version of
   * sendURIToClientForDisplay(). This version takes an options
   * argument which controls how the sending works.
   *
   * Calling this function with tab state will eventually result in a
   * record in another collection being created. This record is only
   * referenced in the command. It is protected against orphanage by a
   * server-side expiration TTL.
   *
   * Tab state is a complicated beast. As far as this API is concerned,
   * tab state is treated as a black box. However, various clients expect
   * a specific format. Code that deals with the specifics is purposefully
   * located outside of the Clients engine.
   *
   * @param uri
   *        String URI to send to the remote client.
   * @param client
   *        String client ID to send the command to. Must be defined.
   * @param options
   *        Object containing metadata to control how sending works. Can
   *        contain the following keys:
   *          tabState - Tab's state. If not defined, no tab state is sent.
   *
   *          ttl - TTL for record containing tab state. If not defined, it
   *          will default to a reasonable value.
   */
  sendURIToClient: function sendURIToClient(uri, client, options) {
    this._log.info("Sending tab to client: " + uri + " -> " + client);

    let input = options || {};

    let args = {
      uri:      uri,
      senderID: this.localID
    };

    // Tab states can be large and all commands are in one record, so
    // sending many tabs could cause the client record to become quite large.
    // We work around this problem by storing the tab state in a foreign
    // record, outside of the clients collection.
    let guid, outgoingRecord;
    if ("tabState" in input) {
      let ttl = DEFAULT_TAB_STATE_TTL;
      if ("ttl" in input) {
        ttl = input.ttl;
      }

      guid = Utils.makeGUID();
      args.stateID = guid;
      outgoingRecord = {
        ttl:   ttl,
        state: input.tabState
      };

      this._log.debug("Prepared tab state record: " + guid);
    }

    this.sendCommand("displayTab", [args], client);

    // Wait until after sendCommand() to record the outgoing record in case
    // sendCommand() throws.
    if (guid && outgoingRecord) {
      this._store._outgoingSendTabRecords[guid] = outgoingRecord;
    }

    Clients._tracker.score += SCORE_INCREMENT_XLARGE;
  },

  /**
   * Handle received displayTab commands.
   *
   * After assembling all the command data, this function fires a
   * weave:engine:clients:display-tab notification. The subject is an object
   * containing the following fields:
   *
   *   uri      - String URI to display
   *   tabState - Object defining tab state. May not be defined. The tab state
   *              is treated as a black box to this engine. The format is not
   *              well-defined outside the Clients engine at this time.
   *   senderID - ID of client that sent the tab.
   *
   * In Firefox, the notification is handled by BrowserGlue. The handler then
   * calls back into this engine (restoreTab) with the subject object and a
   * browser instance, and the tab is restored. This may seem like a very
   * roundabout way of doing things. However, the alternative is UI code would
   * be tightly integrated with Sync, which is supposed to remain application
   * agnostic.
   */
  _handleDisplayTab: function _handleDisplayTab(args) {
    this._log.info("Received a tab for display: " + args.uri);

    let state;

    // Commands may or may not have tab state. If they do, it is stored in a
    // foreign record, which we'll need to fetch.
    if ("stateID" in args) {
      let record = new SendTabRecord(TAB_STATE_COLLECTION, args.stateID);
      let uri = this.tabStateURL + "/" + args.stateID;

      this._log.debug("Fetching remote record from: " + uri);

      try {
        // This is synchronous and spins the event loop. It also throws on
        // some errors.
        record.fetch(uri);

        record.decrypt();
        state = record.tabState;
        this._log.debug("Received tab state record: " + args.stateID);

        // Issue an async delete request for the resource. We don't care
        // what the response is.
        new AsyncResource(uri).delete(function() {});
      }
      catch (ex) {
        this._log.error("Error fetching tab state record (" + args.stateID +
                        "). Ignoring tab state: " + ex);
      }
    }

    let subject = {
      uri:      args.uri,
      tabState: state,
      senderID: args.senderID
    };
    Svc.Obs.notify("weave:engine:clients:display-tab", subject);
  }
};
function ClientStore(name) {
  Store.call(this, name);
}
ClientStore.prototype = {
  __proto__: Store.prototype,

  // Holds SendTab records created by "displayTab" command which haven't
  // yet been uploaded. Maps Record ID -> payload object.
  _outgoingSendTabRecords: {},

  create: function create(record) {
    this.update(record);
  },

  update: function update(record) {
    // Only grab commands from the server; local name/type always wins
    if (record.id == Clients.localID)
      Clients.localCommands = record.commands;
    else
      this._remoteClients[record.id] = record.cleartext;
  },

  createRecord: function createRecord(id, collection) {
    let record = new ClientsRec(collection, id);

    // Package the individual components into a record for the local client
    if (id == Clients.localID) {
      record.name = Clients.localName;
      record.type = Clients.localType;
      record.commands = Clients.localCommands;
    }
    else
      record.cleartext = this._remoteClients[id];

    return record;
  },

  itemExists: function itemExists(id) id in this.getAllIDs(),

  getAllIDs: function getAllIDs() {
    let ids = {};
    ids[Clients.localID] = true;
    for (let id in this._remoteClients)
      ids[id] = true;
    return ids;
  },

  wipe: function wipe() {
    this._remoteClients          = {};
    this._outgoingSendTabRecords = {};
  },
};

function ClientsTracker(name) {
  Tracker.call(this, name);
  Svc.Obs.add("weave:engine:start-tracking", this);
  Svc.Obs.add("weave:engine:stop-tracking", this);
}
ClientsTracker.prototype = {
  __proto__: Tracker.prototype,

  _enabled: false,

  observe: function observe(subject, topic, data) {
    switch (topic) {
      case "weave:engine:start-tracking":
        if (!this._enabled) {
          Svc.Prefs.observe("client.name", this);
          this._enabled = true;
        }
        break;
      case "weave:engine:stop-tracking":
        if (this._enabled) {
          Svc.Prefs.ignore("clients.name", this);
          this._enabled = false;
        }
        break;
      case "nsPref:changed":
        this._log.debug("client.name preference changed");
        this.addChangedID(Svc.Prefs.get("client.GUID"));
        this.score += SCORE_INCREMENT_XLARGE;
        break;
    }
  }
};
