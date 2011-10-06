/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/engines/forms.js");
Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/log4moz.js");

const DONE = Repository.prototype.DONE;

function run_test() {
  initTestLogging();
  let logger = Log4Moz.repository.getLogger("Sync.FormsRepositorySession");
  logger.level = Log4Moz.Trace;
  run_next_test();
}

/**
 * A helper map of fieldname to guid. Of course, fieldnames
 * in the DB must be distinct.
 */
let guidsMap = {};

/**
 * Helper for fetching guids for records by fieldname.
 *
 * @param names
 *        An array of fieldname values.
 *
 * @return An array of guids.
 */
function guids(names) {
  let out = names.map(function (fieldname) {
    _("Looking up " + fieldname + " in " + JSON.stringify(guidsMap));
    return guidsMap[fieldname];
  });
  _("GUIDs are: " + JSON.stringify(out));
  return out;
}

function buildGUIDsMap(resultSet) {
  let r;
  while ((r = resultSet.getNextRow()) != null) {
    let fieldname = r.getResultByName("fieldname");
    guidsMap[fieldname] = r.getResultByName("guid");
  }
}

function setLastUsed(record, time) {
  Svc.Form.DBConnection.executeSimpleSQL(
    "UPDATE moz_formhistory SET lastUsed = " + time +
    " WHERE fieldname = '" + record + "'");
}

add_test(function test_empty_guidsSince() {
  let repo = new FormsRepository();
  withSession(repo, function (session) {
    session.guidsSince(0, function (err, guids) {
      do_check_true(!err);
      do_check_eq(guids.length, 0);
      finishSession(session);
    });
  });
});

add_test(function test_add_data() {
  _("Adding entries.");
  Svc.Form.addEntry("record1", "some contents");
  Svc.Form.addEntry("record2", "more contents");

  // Update lastUsed times to known values.
  setLastUsed("record1", 100000);
  setLastUsed("record2", 200000);

  const query = "SELECT fieldname, guid " +
                "FROM moz_formhistory";
  let stmt = Svc.Form.DBConnection.createAsyncStatement(query);
  let cb = {
    handleResult: function handleResult(resultSet) {
      buildGUIDsMap(resultSet);
    },
    handleCompletion: function handleCompletion(reason) {
      run_next_test();
    }
  };
  stmt.executeAsync(cb);
});

add_test(function test_retrieve() {
  let repo  = new FormsRepository();
  let step  = 0;
  let steps = [[0,      guids(["record1", "record2"])],
               [100000, guids(["record1", "record2"])],
               [150000, guids(["record2"])],
               [200000, guids(["record2"])],
               [200001, []]];

  function checkGUIDs(session) {
    _("Step " + step + "...");
    if (step >= steps.length) {
      finishSession(session);
      return;
    }

    let [timestamp, expected] = steps[step++];

    _("Checking since " + timestamp + "...");
    session.guidsSince(timestamp, function (err, guids) {
      do_check_true(!err);
      do_check_eq(guids.length, expected.length);
      for (let i = 0; i < expected.length; i++) {
        do_check_eq(guids[i], expected[i]);
      }
      Utils.nextTick(checkGUIDs.bind(this, session));
    });
  }
  withSession(repo, checkGUIDs);
});
