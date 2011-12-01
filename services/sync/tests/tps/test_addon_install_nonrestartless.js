
/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

let phases = {
  "phase01": "profile1",
  "phase02": "profile1",
  "phase03": "profile2",
  "phase04": "profile2"
};

const id = "unsigned-xpi@tests.mozilla.org";

Phase("phase01", [
  [Sync, SYNC_WIPE_SERVER],
  [Addons.verifyNot, [id]],
  [Addons.install, ["unsigned-1.0.xml"]],
  [Addons.verify, [id], STATE_DISABLED],
]);
Phase("phase02", [
  [Addons.verify, [id], STATE_ENABLED],
  [Sync],
]);
Phase("phase03", [
  [Addons.verifyNot, [id]],
  [Sync],
]);
Phase("phase04", [
  [Addons.verify, [id], STATE_ENABLED],
]);
