/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/*
 * The list of phases mapped to their corresponding profiles.  The object
 * here must be in strict JSON format, as it will get parsed by the Python
 * testrunner (no single quotes, extra comma's, etc).
 */

var phases = { "phase1": "profile1",
               "phase2": "profile1",
               "phase3": "profile2",
               "phase4": "profile2",
               "phase5": "profile1",
               "phase6": "profile2",
               "phase7": "profile1" };

/*
 * Test phases
 */

/*Initial Setup & prep for installing nonrestartless test.
 *  NB: a nonrestartless addon will be 'present'(detectable by the tests
 *  but not installed,but in disabled state until it is actually
 *  installed when the profile is restarted.
*/
Phase('phase1', [
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
  [Addons.install, ['unsigned-1.0.xml']],
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
]);

/**
 * unsigned-xpi@tests.mozilla.org is a non restartless addon. will not
 * be installed until profile has been closed & restarted.
 */
Phase('phase2', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Sync, SYNC_WIPE_SERVER],

]);
/* Verify sync of installed addon, prep for disable test.
 */ 
Phase('phase3', [
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
  [Sync],
]);

/* Should have found/installed addon from the sync at end of previous
 * phase */
Phase('phase4', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Addons.setState, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
  [Sync],
]);

/* Verify disabled, prep for enable testing.
 */
Phase('phase5', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
  [Addons.setState, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
]);

/* Verify enabled, prep for uninstall testing.
 */
Phase('phase6', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_DISABLED],
  [Sync],
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Addons.uninstall, ['unsigned-xpi@tests.mozilla.org']],
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
  [Sync],
]);

/* Verify uninstalled.
 */
Phase('phase7', [
  [Addons.verify, ['unsigned-xpi@tests.mozilla.org'], STATE_ENABLED],
  [Sync],
  [Addons.verifyNot, ['unsigned-xpi@tests.mozilla.org']],
]);
