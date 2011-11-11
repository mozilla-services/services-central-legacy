/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/engines/clients.js");
Cu.import("resource://services-sync/policies.js");
Cu.import("resource://services-sync/service.js");

const PASSPHRASE = "abcdeabcdeabcdeabcdeabcdea";

function get_server_for_clients_engine(username, password) {
  password = password || "password";
  let users = {};
  users[username] = password;
  return serverForUsers(users, {
    meta: {
      global: {
        engines: {
          clients: {version: Clients.version, syncID: Clients.syncID}
        }
      }
    },
    sendtab: {}
  });
}

function configure_client_and_get_server(username) {
  const password = "password";

  Svc.Prefs.set("serverURL", "http://localhost:8080/");
  Svc.Prefs.set("clusterURL", "http://localhost:8080/");
  let server = get_server_for_clients_engine(username, password);

  generateNewKeys();
  Service.username   = username;
  Service.password   = password;
  Service.passphrase = PASSPHRASE;

  return server;
}

function reset_and_advance_test(server) {
  Svc.Prefs.resetBranch("");
  Records.clearCache();

  Service.startOver();

  if (server) {
    server.stop(run_next_test);
  }
  else {
    run_next_test();
  }

  // We never get here.
}

function run_test() {
  initTestLogging("Trace");
  Log4Moz.repository.getLogger("Sync.Engine.Clients").level = Log4Moz.Level.Trace;
  run_next_test();
}

add_test(function test_send_tab_to_client() {
  _("Ensure proper semantics of sendURIToClient().");

  generateNewKeys();
  Clients.wipeClient();

  let tracker = Clients._tracker;
  let store = Clients._store;

  let remoteId = Utils.makeGUID();
  let rec = new ClientsRec("clients", remoteId);
  rec.name = "remote";
  store.create(rec);
  let remoteRecord = store.createRecord(remoteId, "clients");

  tracker.clearChangedIDs();
  let initialScore = tracker.score;

  _("Ensure sending a tab without tab state works.");
  let uri = "http://www.mozilla.org/";
  Clients.sendURIToClient(uri, remoteId);
  let newRecord = store._remoteClients[remoteId];

  do_check_neq(undefined, newRecord);
  do_check_eq(1, newRecord.commands.length);

  let command = newRecord.commands[0];
  do_check_eq("displayTab", command.command);
  do_check_eq(1, command.args.length);
  do_check_eq("object", typeof command.args[0]);
  do_check_eq(uri, command.args[0].uri);
  do_check_eq(Clients.localID, command.args[0].senderID);
  do_check_eq(2, Object.keys(command.args[0]).length);

  do_check_true(tracker.score > initialScore);
  do_check_true(tracker.score - initialScore >= SCORE_INCREMENT_XLARGE);

  do_check_eq(0, Object.keys(store._outgoingSendTabRecords).length);

  _("Ensure sending a tab with tab state results in queued record upload.");
  remoteId = Utils.makeGUID();
  rec = new ClientsRec("clients", remoteId);
  rec.name = "remote";
  store.create(rec);
  remoteRecord = store.createRecord(remoteId, "clients");
  tracker.clearChangedIDs();
  initialScore = tracker.score;

  let state = "foo;bar;"; // Actual value doesn't matter.
  Clients.sendURIToClient(uri, remoteId, {tabState: state});
  newRecord = store._remoteClients[remoteId];

  do_check_neq(undefined, newRecord);
  do_check_eq(1, newRecord.commands.length);
  command = newRecord.commands[0];
  do_check_eq("displayTab", command.command);
  do_check_eq(1, command.args.length);
  do_check_eq("object", typeof command.args[0]);
  do_check_eq(3, Object.keys(command.args[0]).length);
  do_check_eq(uri, command.args[0].uri);
  do_check_eq(Clients.localID, command.args[0].senderID);
  do_check_true("stateID" in command.args[0]);

  do_check_true(tracker.score > initialScore);
  do_check_true(tracker.score - initialScore >= SCORE_INCREMENT_XLARGE);

  let outgoing = store._outgoingSendTabRecords;
  do_check_eq("object", typeof outgoing);
  do_check_eq(1, Object.keys(outgoing).length);
  let key = command.args[0].stateID;
  do_check_true(key in outgoing);
  let r = outgoing[key];
  do_check_eq("object", typeof r);
  do_check_eq(2, Object.keys(r).length);
  do_check_eq(1814400, r.ttl);
  do_check_eq(state, r.state);

  _("Ensure options TTL is recorded.");
  remoteId = Utils.makeGUID();
  rec = new ClientsRec("clients", remoteId);
  rec.name = "remote";
  store.create(rec);
  remoteRecord = store.createRecord(remoteId, "clients");

  Clients.sendURIToClient(uri, remoteId, {tabState: state, ttl: 60});
  newRecord = store._remoteClients[remoteId];
  outgoing = store._outgoingSendTabRecords;
  key = newRecord.commands[0].args[0].stateID;
  do_check_true(key in outgoing);
  do_check_eq(60, outgoing[key].ttl);

  Clients.wipeClient();

  _("Ensure unknown client ID results in exception.");
  let unknownId = Utils.makeGUID();
  let error;

  try {
    Clients.sendURIToClient(uri, unknownId, {tabState: state});
  } catch (ex) {
    error = ex;
  }

  do_check_eq(0, error.message.indexOf("Unknown remote client ID: "));

  _("Ensure we don't have an outgoing tab state record for unknown client ID");
  do_check_eq(0, Object.keys(store._outgoingSendTabRecords).length);

  reset_and_advance_test();
});

add_test(function test_receive_display_tab_no_state() {
  _("Ensure processing of received 'displayTab' command with no state works.");

  Clients.wipeClient();

  const uri = "http://www.mozilla.org/";
  let remoteId = Utils.makeGUID();

  let command = {
    command: "displayTab",
    args: [{uri: uri, senderID: "foobar"}]
  };
  Clients.localCommands = [command];

  const ev = "weave:engine:clients:display-tab";

  let handler = function(subject, data) {
    Svc.Obs.remove(ev, handler);
    do_check_neq(undefined, subject);
    do_check_eq(undefined, data);
    do_check_eq("object", typeof subject);
    do_check_eq(3, Object.keys(subject).length);
    do_check_eq(uri, subject.uri);
    do_check_eq(undefined, subject.tabState);
    do_check_eq("foobar", subject.senderID);

    reset_and_advance_test();
  };

  Svc.Obs.add(ev, handler);
  do_check_true(Clients.processIncomingCommands());
});

add_test(function test_receive_display_tab_with_state() {
  _("Ensure 'displayTab' command with tab state is processed properly");

  const uri      = "http://www.mozilla.org/";
  const recordID = "testrecord";
  const state    = "DUMMY STATE";
  const senderID = "foobar";
  const username = "barfoo";

  let server = configure_client_and_get_server(username);

  let cw = new CryptoWrapper("sendtab", recordID);
  cw.cleartext = {
    id:       recordID,
    tabState: state
  };
  cw.encrypt();

  let wbo = new ServerWBO(recordID, {
    ciphertext: cw.ciphertext,
    IV:         cw.IV,
    hmac:       cw.hmac
  });
  server.insertWBO(username, "sendtab", wbo);

  let command = {
    command: "displayTab",
    args:    [{uri: uri, senderID: senderID, stateID: recordID}]
  };
  Clients.localCommands = [command];

  const ev = "weave:engine:clients:display-tab";

  let handler = function(subject, data) {
    Svc.Obs.remove(ev, handler);

    do_check_eq("object", typeof subject);
    do_check_eq(3, Object.keys(subject).length);
    do_check_eq(uri, subject.uri);
    do_check_eq(state, subject.tabState);
    do_check_eq(senderID, subject.senderID);

    reset_and_advance_test(server);
  };

  Svc.Obs.add(ev, handler);
  do_check_true(Clients.processIncomingCommands());
});

add_test(function test_display_tab_sync() {
  _("Ensures sending a tab between two clients via sync works.");

  const username = "tabsync";

  let server = configure_client_and_get_server(username);

  let senderID = Clients.localID;
  let remoteID = Utils.makeGUID();

  let remoteClientRecord = new ClientsRec("clients", remoteID);
  Clients._store.create(remoteClientRecord);
  Clients._store.createRecord(remoteID, "clients");

  const uri = "http://www.mozilla.org/";
  const state = "TAB STATE";
  Clients.sendURIToClient(uri, remoteID, {tabState: state});
  // Reset the global score so an automatic sync does not occur.
  SyncScheduler.globalScore = 0;

  do_check_eq(1, Object.keys(Clients._store._outgoingSendTabRecords).length);

  let stateRecordID = Object.keys(Clients._store._outgoingSendTabRecords)[0];

  Clients.sync();

  let clientCollection = server.user(username).collection("clients");
  let stateCollection  = server.user(username).collection("sendtab");

  let stateRecord = stateCollection.wbo(stateRecordID);
  do_check_neq(undefined, stateRecord);

  _("Wiping clients engine");
  Clients.wipeClient();
  Svc.Prefs.set("client.GUID", remoteID);
  Clients.sync();
  do_check_eq(1, Clients.localCommands.length);

  let command = Clients.localCommands[0];
  do_check_eq("displayTab", command.command);

  const ev = "weave:engine:clients:display-tab";

  let handler = function(subject, data) {
    Svc.Obs.remove(ev, handler);
    do_check_eq(3, Object.keys(subject).length);
    do_check_eq(uri, subject.uri);
    do_check_eq(state, subject.tabState);
    do_check_eq(senderID, subject.senderID);

    reset_and_advance_test(server);
  };

  Svc.Obs.add(ev, handler);
  do_check_true(Clients.processIncomingCommands());
});

add_test(function test_multiple_send_tab_commands() {
  _("Ensure multiple send tab commands sent at once works.");

  const username = "multiple_tabs_send";
  let server = configure_client_and_get_server(username);

  // Perform initial sync.
  Service.sync();
  Svc.Obs.notify("weave:engine:stop-tracking");

  let senderID = Clients.localID;
  let remoteIDs = [Utils.makeGUID(), Utils.makeGUID()];

  for each (let id in remoteIDs) {
    let record = new ClientsRec("clients", id);
    Clients._store.create(record);
    Clients._store.createRecord(id, "clients");
  }

  const uris = {};
  uris["http://www.mozilla.org/"] = "STATE0";
  uris["http://www.mozilla.com/"] = "STATE1";

  let totalSends = 0;

  for each (let id in remoteIDs) {
    for (let [uri, state] in Iterator(uris)) {
      Clients.sendURIToClient(uri, id, {tabState: state});
      totalSends++;
    }
  }

  do_check_eq(totalSends,
              Object.keys(Clients._store._outgoingSendTabRecords).length);

  let sendTabRecordIDs = Object.keys(Clients._store._outgoingSendTabRecords);

  _("Forcing sync of outgoing records");
  Clients.sync();

  let clientCollection = server.user(username).collection("clients");
  let stateCollection  = server.user(username).collection("sendtab");

  for (let i = 0; i < sendTabRecordIDs.length; i++) {
    let id = sendTabRecordIDs[i];
    let wbo = stateCollection.wbo(id);

    do_check_neq(undefined, wbo);
  }

  reset_and_advance_test(server);
});

add_test(function test_receive_multiple_commands() {
  _("Ensure that a client receiving multiple commands works as expected.");

  const username = "multiple_commands_receive";
  let server = configure_client_and_get_server(username);
  Clients.localCommands = [];

  let args = [
    {
      uri:      "https://www.mozilla.org/",
      senderID: Utils.makeGUID(),
      stateID:  Utils.makeGUID()
    },
    {
      uri: "https://docs.services.mozilla.org/",
      senderID: Utils.makeGUID(),
      stateID:  Utils.makeGUID()
    }
  ];

  for each (let arg in args) {
    let cw = new CryptoWrapper("sendtab", arg.stateID);
    cw.cleartext = {
      id:  arg.stateID,
      tabState: {foo: "bar"}
    };
    cw.encrypt();

    let wbo = new ServerWBO(arg.stateID, {
      ciphertext: cw.ciphertext,
      IV:         cw.IV,
      hmac:       cw.hmac
    });
    server.insertWBO(username, "sendtab", wbo);

    Clients.localCommands.push({command: "displayTab", args: [arg]});
  }

  do_check_eq(2, Clients.localCommands.length);

  const ev = "weave:engine:clients:display-tab";

  let callbackCount = 0;
  let handler = function(subject) {
    let arg = args[callbackCount];

    do_check_eq(3, Object.keys(subject).length);
    do_check_eq(arg.uri, subject.uri);
    do_check_eq(arg.senderID, subject.senderID);

    callbackCount++;

    if (callbackCount == args.length) {
      Svc.Obs.remove(ev, handler);

      reset_and_advance_test(server);
    }
  }

  Svc.Obs.add(ev, handler);
  do_check_true(Clients.processIncomingCommands());
});

add_test(function test_record_fetch_failure() {
  _("Ensure that failures when fetching sendtab records are handled.");

  const recordID = Utils.makeGUID();
  const uri = "https://www.mozilla.org/";
  const ev = "weave:engine:clients:display-tab";

  let server = configure_client_and_get_server("fetch_failure");

  let handler = function handler(subject) {
    Svc.Obs.remove(ev, handler);

    do_check_eq(undefined, subject.tabState);

    reset_and_advance_test(server);
  };

  Svc.Obs.add(ev, handler);

  Clients._handleDisplayTab({
    uri:      uri,
    senderID: Utils.makeGUID(),
    stateID:  recordID
  });
});
