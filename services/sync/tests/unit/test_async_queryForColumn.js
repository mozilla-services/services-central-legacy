/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

_("Minimal tests for Async.queryForColumn.");

Cu.import("resource://services-sync/async.js");

const SQLITE_CONSTRAINT_VIOLATION = 19;  // http://www.sqlite.org/c3ref/c_abort.html

let connection;
function run_test() {
  initTestLogging("Trace");

  connection = Svc.Form.DBConnection;
  if (!connection) {
    do_throw("Couldn't get DB connection.");
  }

  run_next_test();
}

function c(query) {
  return connection.createStatement(query);
}

add_test(function test_delete() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(0, results.length);
    run_next_test();
  }
  Async.queryForColumn(c("DELETE FROM moz_formhistory"), "", next);
});

add_test(function test_select_1_no_results() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(0, results.length);
    run_next_test();
  }
  Async.queryForColumn(c("SELECT 1 FROM moz_formhistory"), "", next);
});

add_test(function test_insert_1() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(0, results.length);
    run_next_test();
  }
  let stmt = c("INSERT INTO moz_formhistory (fieldname, value) " +
               "       VALUES ('foo', 'bar')");
  Async.queryForColumn(stmt, "", next);
});

add_test(function test_select_1_1_result() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(1, results.length);
    do_check_eq(results[0], "1");
    run_next_test();
  }
  Async.queryForColumn(c("SELECT 1 FROM moz_formhistory"), "1", next);
});

add_test(function test_select_fieldname() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(1, results.length);
    do_check_eq(results[0], "foo");
    run_next_test();
  }
  let stmt = c("SELECT fieldname FROM moz_formhistory");
  Async.queryForColumn(stmt, "fieldname", next);
});

add_test(function test_select_value() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(1, results.length);
    do_check_eq(results[0], "bar");
    run_next_test();
  }
  let stmt = c("SELECT value FROM moz_formhistory");
  Async.queryForColumn(stmt, "value", next);
});

add_test(function test_insert_2() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(0, results.length);
    run_next_test();
  }
  let stmt = c("INSERT INTO moz_formhistory (fieldname, value) " +
               "       VALUES ('baz', 'noo')");
  Async.queryForColumn(stmt, "", next);
});

add_test(function test_select_fieldname() {
  function next(err, results) {
    do_check_true(!err);
    do_check_eq(2, results.length);
    do_check_eq(results[0], "foo");
    do_check_eq(results[1], "baz");
    run_next_test();
  }
  let stmt = c("SELECT fieldname FROM moz_formhistory");
  Async.queryForColumn(stmt, "fieldname", next);
});

add_test(function test_error() {
  function next(err, results) {
    do_check_true(!!err);
    do_check_eq(err.result, SQLITE_CONSTRAINT_VIOLATION);
    run_next_test();
  }

  let stmt = c("INSERT INTO moz_formhistory (fieldname, value)" +
               "       VALUES ('one', NULL)");
  Async.queryForColumn(stmt, "", next);
});
