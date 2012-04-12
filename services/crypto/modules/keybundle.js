/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, results: Cr, Utils: Cu} = Components;

const EXPORTED_SYMBOLS = ["KeyBundle"];

let fakeCryptoCounter = 0;

/**
 * Holds a reference to a key bundle instance.
 *
 * This type represents a pair of 256 bit keys and optional metadata. One
 * key is used for symmetric AES encryption; the other for HMAC message
 * verification.
 *
 * Actual key operations are performed by NSS. This type is effectively a
 * pointer to opaque data with an interface to perform various operations.
 *
 * The public interface purposefully does not provide access to the underlying
 * key matter. By keeping key matter inside NSS, this code can run in FIPS
 * mode.
 */
function KeyBundle() {

}
KeyBundle.prototype = {
  /**
   * The metadata associated with the key bundle.
   *
   * If no metadata is associated, this is null.
   */
  get metadata() {
    throw new Error("Not implemented.");
  },

  /**
   * Set metadata associated with the key bundle.
   *
   * If setting null, metadata will be cleared.
   */
  set metadata(value) {
    throw new Error("No implemented.");
  },

  /**
   * Create a new key bundle context from a random source.
   *
   * Returns a KeyBundle instance.
   *
   * This should be used as a static method. e.g.
   *
   *   let ctx = KeyBundle.createFromRandom();
   */
  createFromRandom: function createFromRandom() {
    this._matter = "fake-bundle-" + fakeCryptoCounter;

    fakeCryptoCounter += 1;
  },

  /**
   * Wraps another KeyBundle with this one.
   *
   * This encrypts and signs the passed KeyBundle using this
   * key bundle and returns a string representing the Base64 encoding of the
   * produced binary message.
   */
  wrapAndBase64EncodeBundle: function wrapAndBase64EncodeBundle(bundle) {
    let pieces = ["wrapped", this._matter, bundle._matter];

    return CommonUtils.safeAtoB(pieces.join(" "));
  },

  /**
   * Unwrap another KeyBundle that was wrapped with this one.
   *
   * This is the opposite of wrapAndBase64EncodeBundle(). It takes the Base64
   * encoding of a wrapped KeyBundle and verifies and decrypts it using
   * this key bundle. It returns a KeyBundle instance for the unwrapped
   * key bundle.
   */
  unwrapBase64EncodedBundle: function unwrapBase64EncodedBundle(message) {
    let data = btoa(message);

    let pieces = data.split(":", 3);
    if (pieces.length != 3 || pieces[0] != "wrapped") {
      throw new Error("Message does not appear to be a wrapped key.");
    }

    if (pieces[1] != this._matter) {
      throw new Error("Bundle was not wrapped with this one.");
    }

    let bundle = new KeyBundle();
    bundle._matter = pieces[2];

    return bundle;
  },

  /**
   * Encrypt and sign cleartext using this key bundle.
   *
   * Returns a string representing the Base64 encoded value of the produced
   * binary message.
   */
  encodeAndBase64Encode: function encodeAndBase64Encode(cleartext) {
    let pieces = ["encoded", this._matter, cleartext];

    return CommonUtils.safeAtoB(pieces.join(":"));
  },

  /**
   * Verify and decrypt a message encrypted with this key bundle.
   *
   * This is the opposite of encryptAndBase64Encode().
   *
   * Returns a string representing the input message.
   *
   * If an error occurs, this will throw an Error.
   *
   * TODO document error semantics.
   */
  decodeBase64Encoded: function decodeBase64Encoded(message) {
    let data = btoa(message);
    let pieces = data.split(":", 3);

    if (pieces.length != 3 || pieces[0] != "encoded") {
      throw new Error("Message does not appear to be encoded data.");
    }

    if (pieces[1] != this._matter) {
      throw new Error("Message not encoded with this bundle.");
    }

    return pieces[2];
  },

  //--------------------------------------------------
  // INTERNAL API                                     |
  //                                                  |
  // Only use things below for testing and debugging. |
  //--------------------------------------------------|

  /**
   * Obtain the raw encryption key.
   */
  get encryptionKey() {
    throw new Error("Not implemented.");
  },

  /**
   * Obtain the raw HMAC key.
   */
  get hmacKey() {
    throw new Error("Not implemented.");
  },
};
