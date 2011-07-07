/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://services-sync/repository.js");
Cu.import("resource://services-sync/record.js");
Cu.import("resource://services-sync/util.js");

const DONE = Repository.prototype.DONE;
const STOP = Repository.prototype.STOP;

function run_test() {
  run_next_test();
}

function setup_fixtures() {
  let repo = new WBORepository();
  let keyBundle = new BulkKeyBundle(null, "testing");
  keyBundle.generateRandom();
  let crypto5 = new Crypto5Middleware(repo, keyBundle);
  return crypto5;
}

add_test(function test_roundtrip() {
  let crypto5 = setup_fixtures();
  let record = {id: "0000deadbeef",
                sortindex: 25,
                ttl: 42,
                payload: {id: "0000deadbeef",
                          title: "Dead Beef!"}};

  // Pass a copy because encrypt() will modify the object.
  let wbo = crypto5.encrypt(Utils.deepCopy(record));
  do_check_true(Utils.deepEquals(record, crypto5.decrypt(wbo)));
  run_next_test();
});

add_test(function test_encrypt() {
  let crypto5 = setup_fixtures();
  let record = {id: "0000deadbeef",
                sortindex: 25,
                ttl: 42,
                payload: {id: "0000deadbeef",
                          title: "Dead Beef!"}};

  let wbo = crypto5.encrypt(record);
  do_check_eq(wbo.id, record.id);

  // 'ttl' and 'sortindex' have moved to the WBO.
  do_check_false("ttl" in record);
  do_check_false("sortindex" in record);
  do_check_eq(wbo.sortindex, 25);
  do_check_eq(wbo.ttl, 42);

  // Verify HMAC.
  let payload = JSON.parse(wbo.payload);
  let keyBundle = crypto5.keyBundle;
  let expectedHMAC = Utils.bytesAsHex(
    Utils.digestUTF8(payload.ciphertext, keyBundle.sha256HMACHasher));
  do_check_eq(payload.hmac, expectedHMAC);

  // Verify IV.
  do_check_eq(Utils.safeAtoB(payload.IV).length, 16);

  // Verify ciphertext.
  let cleartext = Svc.Crypto.decrypt(payload.ciphertext,
                                     keyBundle.encryptionKey,
                                     payload.IV);
  let data = JSON.parse(cleartext);
  do_check_true(Utils.deepEquals(data, record));

  run_next_test();
});

add_test(function test_decrypt() {
  run_next_test(); //TODO
});

add_test(function test_decrypt_hmac_mismatch() {
  run_next_test(); //TODO
});

add_test(function test_decrypt_id_mismatch() {
  run_next_test(); //TODO
});
