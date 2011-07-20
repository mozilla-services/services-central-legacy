/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/synchronizer.js");
Cu.import("resource://services-sync/log4moz.js");

const DONE = Repository.prototype.DONE;
const STOP = Repository.prototype.STOP;

function run_test() {
  // Monkey-patch fake crypto in place.
  let fakeCrypto = new FakeCryptoService(); // Installs itself as Svc.Crypto.
  Crypto5Middleware.prototype.ciphertextHMAC = fakeCrypto.sha256HMAC;

  run_next_test();
}

add_test(function test_sync_through_crypto_middleware() {
  _("Make sure that items end up passing through crypto middleware during sync.");
  let r1 = new WBORepository();
  let r2 = new WBORepository();

  let k1 = new BulkKeyBundle(null, "testing");
  k1.generateRandom();
  let c1 = new Crypto5Middleware(r1, k1);
  r1.toString = function () "<CryptoRepository>";
  r2.toString = function () "<WBORepository>";

  let now = Date.now();
  r2.wbos = {
    "123412341234": {id: "123412341234",
                     modified: now - 1,
                     payload: "Bar4"},
    "123412341235": {id: "123412341235",
                     modified: now - 2,
                     payload: "Bar5"}
  };

  let s1 = new Synchronizer();
  s1.repositoryA = c1;
  s1.repositoryB = r2;

  function firstSyncCallback(error) {
    do_check_true(!error);
    do_check_true("123412341234" in r1.wbos);
    do_check_true("123412341235" in r1.wbos);
    let item1 = r1.wbos["123412341234"];
    let item2 = r1.wbos["123412341235"];
    let payload1 = JSON.parse(item1.payload);
    let payload2 = JSON.parse(item2.payload);
    do_check_eq(JSON.parse(payload1.ciphertext).id, "123412341234");
    do_check_eq(JSON.parse(payload2.ciphertext).id, "123412341235");
    do_check_eq(JSON.parse(payload1.ciphertext).payload, "Bar4");
    do_check_eq(JSON.parse(payload2.ciphertext).payload, "Bar5");
    run_next_test();
  }

  s1.synchronize(firstSyncCallback);
});
