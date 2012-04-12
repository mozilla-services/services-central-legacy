/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, results: Cr, Utils: Cu} = Components;

const EXPORTED_SYMBOLS = ["KeyBundle"];

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

  },

  /**
   * Set metadata associated with the key bundle.
   *
   * If setting null, metadata will be cleared.
   */
  set metadata(value) {

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

  },

  /**
   * Wraps another KeyBundle with this one.
   *
   * This encrypts and signs the passed KeyBundle using this
   * key bundle and returns a string representing the Base64 encoding of the
   * produced binary message.
   */
  wrapAndBase64EncodeBundle: function wrapAndBase64EncodeBundle(context) {

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

  },

  /**
   * Encrypt and sign cleartext using this key bundle.
   *
   * Returns a string representing the Base64 encoded value of the produced
   * binary message.
   */
  encryptAndBase64Encode: function encryptAndBase64Encode(cleartext) {

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
  decryptBase64EncodedValue: function decryptBase64EncodedValue(message) {

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

  },

  /**
   * Obtain the raw HMAC key.
   */
  get hmacKey() {

  },
};
