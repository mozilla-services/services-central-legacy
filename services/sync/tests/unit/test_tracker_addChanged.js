Cu.import("resource://services-sync/engines.js");

function run_test() {
  let tracker = new Tracker();
  let id = "the_id!";

  _("Make sure nothing exists yet..");
  do_check_eq(tracker.changedIDs[id], null);

  _("Make sure adding of time 0 works");
  tracker.addChangedID(id, 0);
  do_check_eq(tracker.changedIDs[id], 0);

  _("A newer time will replace the old 0");
  let now = Date.now() - 100;
  tracker.addChangedID(id, now);
  do_check_eq(tracker.changedIDs[id], now);

  _("An older time will not replace the newer one.");
  tracker.addChangedID(id, now - 10000);
  do_check_eq(tracker.changedIDs[id], now);

  _("Adding without time defaults to current time");
  tracker.addChangedID(id);
  do_check_true(tracker.changedIDs[id] > now);
}
