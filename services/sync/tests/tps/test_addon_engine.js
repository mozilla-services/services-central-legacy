/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/*
 * The list of phases mapped to their corresponding profiles.  The object
 * here must be in strict JSON format, as it will get parsed by the Python
 * testrunner (no single quotes, extra comma's, etc).
 */

 var phases = { "phase01": "profile1",
               "phase02": "profile1",
               "phase03": "profile2",
               "phase04": "profile2",
               "phase05": "profile1",
               "phase06": "profile1",
               "phase07": "profile2",
               "phase08": "profile2",
               "phase09": "profile1",
               "phase10": "profile1",
               "phase11": "profile2",
               "phase12": "profile2",
               "phase13": "profile1",
               "phase14": "profile1",
               "phase15": "profile2",
               "phase16": "profile2",
               "phase17": "profile1",
               "phase18": "profile2",
               "phase19": "profile1",
               "phase20": "profile2",
               "phase21": "profile1"};
Phase('phase01', [
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
  [Addons.install, ['unsigned-1.0.xml']],
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
]);
Phase('phase02', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
]);
Phase('phase03', [
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
  [Sync],
  /* should be present but not installed?*/
]);
Phase('phase04', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
]);
Phase('phase05', [
  [Addons.setState, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
]);
Phase('phase06', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
  [Sync],
]);
Phase('phase07', [
  [Sync],
]);
Phase('phase08', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
]);
Phase('phase09', [
  [Addons.setState, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
]);
Phase('phase10', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
]);
Phase('phase11', [
  [Sync],
]);
Phase('phase12', [
 [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
]);
Phase('phase13', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Addons.uninstall, ['unsigned-xpi@tests.mozilla.org']],
]);
Phase('phase14', [
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
  [Sync],
]);
Phase('phase15', [
  [Sync],
]);
Phase('phase16', [
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
]);
Phase('phase17', [
  [Addons.verifyNot, ['restartless@tests.mozilla.org']],
  [Addons.install, ['restartless.xml']],
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_ENABLED],
]);
Phase('phase18', [
  [Addons.verifyNot, ['restartless@tests.mozilla.org']],
  [Sync],
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_ENABLED],
  [Addons.setState, ['restartless@tests.mozilla.org'], STATE_DISABLED],
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_DISABLED],
  [Sync],
]);
Phase('phase19', [
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_DISABLED],
  [Addons.setState, ['restartless@tests.mozilla.org'], STATE_ENABLED],
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
]);
Phase('phase20', [
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_DISABLED],
  [Sync],
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_ENABLED],
  [Addons.uninstall,  ['restartless@tests.mozilla.org']],
  [Addons.verifyNot, ['restartless@tests.mozilla.org']],
  [Sync],
]);
Phase('phase21', [
  [Addons.verify, ['restartless@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
  [Addons.verifyNot, ['restartless@tests.mozilla.org']],
]);

