import type { webcrypto } from 'node:crypto';

/* The server's type check leaves out the DOM's types ("lib": ["ES2023"]): the server runs on Node, and the DOM's
   declarations cost the check about 30 MB. @peculiar/x509 and age-encryption name the Web Crypto types the DOM declares,
   and in a library's declarations a name nobody declares silently becomes any. These give those names Node's own types,
   so what goes into a certificate, a key or a crypto provider is checked; test/web-crypto-types.test.ts holds them to it. */
declare global {
  type Algorithm = webcrypto.Algorithm;
  type AlgorithmIdentifier = webcrypto.AlgorithmIdentifier;
  type BufferSource = webcrypto.BufferSource;
  type Crypto = webcrypto.Crypto;
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
  type EcKeyGenParams = webcrypto.EcKeyGenParams;
  type EcKeyImportParams = webcrypto.EcKeyImportParams;
  type EcdsaParams = webcrypto.EcdsaParams;
  type KeyUsage = webcrypto.KeyUsage;
  type RsaHashedImportParams = webcrypto.RsaHashedImportParams;
}

export {};
