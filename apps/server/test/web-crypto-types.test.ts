import type { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { Decrypter, type Identity } from 'age-encryption';
import { describe, expectTypeOf, it } from 'vitest';

/* The server is checked without the DOM's types. @peculiar/x509 and age-encryption name the Web Crypto types the DOM
   declares, and in a library's declarations a name nobody declares silently becomes any: the type check would then let
   anything into a certificate, a key or a crypto provider. These ask the type check itself, so they hold on every run. */
type Key = Awaited<ReturnType<x509.PublicKey['export']>>;
type Provider = ReturnType<typeof x509.cryptoProvider.get>;
type KeyPair = x509.X509CertificateCreateSelfSignedParams['keys'];
type SigningAlgorithm = x509.X509CertificateCreateSelfSignedParams['signingAlgorithm'];
type Bytes = ConstructorParameters<typeof x509.Extension>[2];
type Hash = Parameters<x509.PublicKey['getThumbprint']>[0];
type AgeIdentity = Parameters<Decrypter['addIdentity']>[0];

describe('Web Crypto types of the libraries without the DOM', () => {
  /* An unresolved name passes for any type in an equality check, so this asks first whether it is any at all. */
  it('are not any', () => {
    expectTypeOf<Key>().not.toBeAny();
    expectTypeOf<Provider>().not.toBeAny();
    expectTypeOf<KeyPair>().not.toBeAny();
    expectTypeOf<SigningAlgorithm>().not.toBeAny();
    expectTypeOf<Bytes>().not.toBeAny();
    expectTypeOf<Hash>().not.toBeAny();
    expectTypeOf<AgeIdentity>().not.toBeAny();
  });

  it("are Node's own from node:crypto", () => {
    expectTypeOf<Key>().toEqualTypeOf<webcrypto.CryptoKey>();
    expectTypeOf<Provider>().toEqualTypeOf<webcrypto.Crypto>();
    expectTypeOf<KeyPair>().toEqualTypeOf<webcrypto.CryptoKeyPair>();
    expectTypeOf<SigningAlgorithm>().toEqualTypeOf<webcrypto.Algorithm | webcrypto.EcdsaParams | undefined>();
    expectTypeOf<Bytes>().toEqualTypeOf<webcrypto.BufferSource>();
    expectTypeOf<Hash>().toEqualTypeOf<webcrypto.AlgorithmIdentifier>();
    expectTypeOf<AgeIdentity>().toEqualTypeOf<string | webcrypto.CryptoKey | Identity>();
  });

  it('refuse what is not a key or a crypto provider', () => {
    expectTypeOf(x509.PublicKey.create).toBeCallableWith(new Uint8Array(32));
    // @ts-expect-error text is not a public key
    expectTypeOf(x509.PublicKey.create).toBeCallableWith('a public key');
    // @ts-expect-error a name is not a crypto provider
    expectTypeOf(x509.PublicKey.create).toBeCallableWith(new Uint8Array(32), 'webcrypto');
    // @ts-expect-error a key is not a key pair
    expectTypeOf(x509.X509CertificateGenerator.createSelfSigned).toBeCallableWith({ keys: {} as webcrypto.CryptoKey });
  });
});
