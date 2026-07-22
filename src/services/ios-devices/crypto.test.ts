// @vitest-environment node
import "reflect-metadata";

import { webcrypto } from "node:crypto";

import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { ContentInfo, SignedData } from "pkijs";
import { describe, expect, test } from "vitest";

import {
  generateProfileSigner,
  randomEnrollmentToken,
  sha256,
  signMobileConfig,
  verifyAppleDeviceResponse,
} from "./crypto";

const rsaAlgorithm: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

const crypto = webcrypto as unknown as Crypto;

async function appleLikeFixture() {
  const caKeys = (await webcrypto.subtle.generateKey(rsaAlgorithm, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const ca = await X509CertificateGenerator.createSelfSigned(
    {
      name: "CN=Test Apple iPhone Device CA",
      keys: caKeys,
      signingAlgorithm: rsaAlgorithm,
      extensions: [
        new BasicConstraintsExtension(true, 1, true),
        new KeyUsagesExtension(
          KeyUsageFlags.keyCertSign | KeyUsageFlags.digitalSignature,
          true,
        ),
      ],
    },
    crypto,
  );
  const leafKeys = (await webcrypto.subtle.generateKey(rsaAlgorithm, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const leaf = await X509CertificateGenerator.create(
    {
      subject: "CN=Test iPhone Identity",
      issuer: ca.subject,
      publicKey: leafKeys.publicKey,
      signingKey: caKeys.privateKey,
      signingAlgorithm: rsaAlgorithm,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      ],
    },
    crypto,
  );
  const leafPrivateKey = await webcrypto.subtle.exportKey(
    "pkcs8",
    leafKeys.privateKey,
  );
  return {
    caPem: ca.toString("pem"),
    leafPem: leaf.toString("pem"),
    leafPrivateKeyPem: PemConverter.encode(leafPrivateKey, "PRIVATE KEY"),
  };
}

describe("iOS enrollment crypto", () => {
  test("creates 256-bit URL-safe one-time tokens and stable hashes", () => {
    const token = randomEnrollmentToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(sha256(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(token)).toBe(sha256(token));
  });

  test("generates a ten-year RSA-2048 self-signed profile signer", async () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const signer = await generateProfileSigner("Test Organization", now);
    const certificate = new X509Certificate(signer.certificatePem);
    const publicKey = await certificate.publicKey.export();

    expect(signer.fingerprint).toMatch(/^[A-F0-9]{64}$/);
    expect(signer.createdAt.getTime()).toBe(now.getTime() - 60_000);
    expect(signer.expiresAt.toISOString()).toBe("2036-07-20T00:00:00.000Z");
    expect(publicKey.algorithm).toMatchObject({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
    });
  });

  test("accepts a signed Apple-like response and rejects tampering or another CA", async () => {
    const fixture = await appleLikeFixture();
    const xml =
      '<?xml version="1.0"?><plist><dict><key>Challenge</key><string>token</string></dict></plist>';
    const cms = await signMobileConfig(
      xml,
      fixture.leafPem,
      fixture.leafPrivateKeyPem,
    );
    const contentInfo = ContentInfo.fromBER(
      cms.buffer.slice(
        cms.byteOffset,
        cms.byteOffset + cms.byteLength,
      ) as ArrayBuffer,
    );
    const signedData = new SignedData({ schema: contentInfo.content });
    const signer = signedData.signerInfos[0];

    expect(signer?.version).toBe(1);
    expect(signer?.signatureAlgorithm.algorithmId).toBe("1.2.840.113549.1.1.1");
    expect(signer?.signedAttrs?.attributes.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        "1.2.840.113549.1.9.3",
        "1.2.840.113549.1.9.4",
        "1.2.840.113549.1.9.5",
      ]),
    );

    await expect(verifyAppleDeviceResponse(cms, fixture.caPem)).resolves.toBe(
      xml,
    );

    const tampered = cms.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(
      verifyAppleDeviceResponse(tampered, fixture.caPem),
    ).rejects.toThrow();

    const anotherCa = await generateProfileSigner("Wrong CA");
    await expect(
      verifyAppleDeviceResponse(cms, anotherCa.certificatePem),
    ).rejects.toThrow("not issued by Apple iPhone Device CA");
  });
});
