_("Make sure querySpinningly will synchronously fetch rows for a query asyncly");
Cu.import("resource://services-sync/async.js");

const SQLITE_CONSTRAINT_VIOLATION = 19;  // http://www.sqlite.org/c3ref/c_abort.html

function run_test() {
  initTestLogging("Trace");

  _("Using the form service to test queries");
  function c(query) Svc.Form.DBConnection.createStatement(query);

  _("Make sure the call is async and allows other events to process");
  let isAsync = false;
  Utils.delay(function() isAsync = true, 0);
  do_check_false(isAsync);

  _("Empty out the formhistory table");
  let r0 = Async.querySpinningly(c("DELETE FROM moz_formhistory"));
  do_check_eq(r0, null);

  _("Make sure there's nothing there");
  let r1 = Async.querySpinningly(c("SELECT 1 FROM moz_formhistory"));
  do_check_eq(r1, null);

  _("Insert a row");
  let r2 = Async.querySpinningly(c("INSERT INTO moz_formhistory (fieldname, value) VALUES ('foo', 'bar')"));
  do_check_eq(r2, null);

  _("Request a known value for the one row");
  let r3 = Async.querySpinningly(c("SELECT 42 num FROM moz_formhistory"), ["num"]);
  do_check_eq(r3.length, 1);
  do_check_eq(r3[0].num, 42);

  _("Get multiple columns");
  let r4 = Async.querySpinningly(c("SELECT fieldname, value FROM moz_formhistory"), ["fieldname", "value"]);
  do_check_eq(r4.length, 1);
  do_check_eq(r4[0].fieldname, "foo");
  do_check_eq(r4[0].value, "bar");

  _("Get multiple columns with a different order");
  let r5 = Async.querySpinningly(c("SELECT fieldname, value FROM moz_formhistory"), ["value", "fieldname"]);
  do_check_eq(r5.length, 1);
  do_check_eq(r5[0].fieldname, "foo");
  do_check_eq(r5[0].value, "bar");

  _("Add multiple entries (sqlite doesn't support multiple VALUES)");
  let r6 = Async.querySpinningly(c("INSERT INTO moz_formhistory (fieldname, value) SELECT 'foo', 'baz' UNION SELECT 'more', 'values'"));
  do_check_eq(r6, null);

  _("Get multiple rows");
  let r7 = Async.querySpinningly(c("SELECT fieldname, value FROM moz_formhistory WHERE fieldname = 'foo'"), ["fieldname", "value"]);
  do_check_eq(r7.length, 2);
  do_check_eq(r7[0].fieldname, "foo");
  do_check_eq(r7[1].fieldname, "foo");

  _("Make sure updates work");
  let r8 = Async.querySpinningly(c("UPDATE moz_formhistory SET value = 'updated' WHERE fieldname = 'more'"));
  do_check_eq(r8, null);

  _("Get the updated");
  let r9 = Async.querySpinningly(c("SELECT value, fieldname FROM moz_formhistory WHERE fieldname = 'more'"), ["fieldname", "value"]);
  do_check_eq(r9.length, 1);
  do_check_eq(r9[0].fieldname, "more");
  do_check_eq(r9[0].value, "updated");

  _("Grabbing fewer fields than queried is fine");
  let r10 = Async.querySpinningly(c("SELECT value, fieldname FROM moz_formhistory"), ["fieldname"]);
  do_check_eq(r10.length, 3);

  _("Generate an execution error");
  let r11, except, query = c("INSERT INTO moz_formhistory (fieldname, value) VALUES ('one', NULL)");
  try {
    r11 = Async.querySpinningly(query);
  } catch(e) {
    except = e;
  }
  do_check_true(!!except);
  do_check_eq(except.result, SQLITE_CONSTRAINT_VIOLATION);

  _("Cleaning up");
  Async.querySpinningly(c("DELETE FROM moz_formhistory"));

  _("Make sure the timeout got to run before this function ends");
  do_check_true(isAsync);
}
