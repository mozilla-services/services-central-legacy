/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/record.js");

function run_test() {
  initTestLogging("Trace");

  run_next_test();
}

add_test(function test_empty() {
  _("Ensure empty metaglobal records have proper semantics.");

  let r = new MetaGlobalRecord();
  do_check_eq(r.collection, "meta");
  do_check_eq(r.id, "global");

  do_check_eq(r.syncID, null);
  do_check_eq(r.storageVersion, null);

  let repositories = r.repositories;
  do_check_attribute_count(repositories, 0);
  do_check_false(r.hasRepository("foo"));

  run_next_test();
});

add_test(function test_attributes() {
  _("Ensure attribute getters and setters work.");

  let r = new MetaGlobalRecord();
  r.syncID = "syncID";
  do_check_eq(r.syncID, "syncID");

  r.storageVersion = 5;
  do_check_eq(r.storageVersion, 5);

  r.setRepository("repository", 1, "foobar");
  do_check_true(r.hasRepository("repository"));

  let repository = r.getRepository("repository");
  do_check_eq(repository.syncID, "foobar");
  do_check_eq(repository.version, 1);

  run_next_test();
});

add_test(function test_serialization() {
  _("Ensure serialization works.");

  let r = new MetaGlobalRecord();
  r.syncID = "syncID";
  r.storageVersion = 5;
  r.setRepository("repository", 1, "repositoryID");

  let json = r.toJSON();
  let payload = JSON.parse(JSON.parse(json).payload);

  do_check_attribute_count(payload, 3);
  do_check_eq(payload.syncID, r.syncID);
  do_check_eq(payload.storageVersion, r.storageVersion);
  do_check_attribute_count(payload.repositories, 1);
  do_check_neq(payload.repositories.repository, null);
  do_check_attribute_count(payload.repositories.repository, 2);
  do_check_eq(payload.repositories.repository.syncID,
              r.getRepository("repository").syncID);
  do_check_eq(payload.repositories.repository.version,
              r.getRepository("repository").version);

  let r2 = new MetaGlobalRecord();
  r2.deserialize(json);
  do_check_eq(r2.syncID, r.syncID);
  do_check_eq(r2.storageVersion, r.storageVersion);
  do_check_true(r2.hasRepository("repository"));
  do_check_eq(r2.getRepository("repository").version,
              r.getRepository("repository").version);

  run_next_test();
});
