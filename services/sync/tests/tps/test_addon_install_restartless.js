/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

let phases = {
  "phase01": "profile1",
  "phase02": "profile2"
};

const restartlessID = "restartless-xpi@tests.mozilla.org";

Phase("phase01", [
  [Addons.verifyNot, [restartlessID]],
  [Addons.install, ["restartless-xpi.xml"]],
  [Addons.verify, [restartlessID], STATE_ENABLED],
  [Sync, SYNC_WIPE_SERVER]
]);
Phase("phase02", [
  [Addons.verifyNot, [restartlessID]],
  [Sync],
  [Addons.verify, [restartlessID], STATE_ENABLED]
]);
