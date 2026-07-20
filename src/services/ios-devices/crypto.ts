import { createHash, randomBytes, webcrypto } from "node:crypto";

import * as asn1js from "asn1js";
import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import {
  Certificate,
  ContentInfo,
  CryptoEngine,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  SignedData,
  SignerInfo,
  type ICryptoEngine,
} from "pkijs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const x509Crypto = webcrypto as unknown as Crypto;
const pkijsCrypto = new CryptoEngine({
  name: "node",
  crypto: x509Crypto,
}) as unknown as ICryptoEngine;

const PROFILE_KEY_ALGORITHM: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

// Apple documents this legacy CA as the issuer of the identity certificate used
// to sign a Profile Service response. Its validity dates are intentionally not
// checked; Apple's archived guide explicitly requires ignoring them.
const APPLE_IPHONE_DEVICE_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDaTCCAlGgAwIBAgIBATANBgkqhkiG9w0BAQUFADB5MQswCQYDVQQGEwJVUzET
MBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxLTArBgNVBAMTJEFwcGxlIGlQaG9uZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTAeFw0wNzA0MTYyMjU0NDZaFw0xNDA0MTYyMjU0NDZaMFoxCzAJ
BgNVBAYTAlVTMRMwEQYDVQQKEwpBcHBsZSBJbmMuMRUwEwYDVQQLEwxBcHBsZSBp
UGhvbmUxHzAdBgNVBAMTFkFwcGxlIGlQaG9uZSBEZXZpY2UgQ0EwgZ8wDQYJKoZI
hvcNAQEBBQADgY0AMIGJAoGBAPGUSsnquloYYK3Lok1NTlQZaRdZB2bLl+hmmkdf
Rq5nerVKc1SxywT2vTa4DFU4ioSDMVJl+TPhl3ecK0wmsCU/6TKqewh0lOzBSzgd
Z04IUpRai1mjXNeT9KD+VYW7TEaXXm6yd0UvZ1y8Cxi/WblshvcqdXbSGXH0KWO5
JQuvAgMBAAGjgZ4wgZswDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8w
HQYDVR0OBBYEFLL+ISNEhpVqedWBJo5zENinTI50MB8GA1UdIwQYMBaAFOc0Ki4i
3jlga7SUzneDYS8xoHw1MDgGA1UdHwQxMC8wLaAroCmGJ2h0dHA6Ly93d3cuYXBw
bGUuY29tL2FwcGxlY2EvaXBob25lLmNybDANBgkqhkiG9w0BAQUFAAOCAQEAd13P
Z3pMViukVHe9WUg8Hum+0I/0kHKvjhwVd/IMwGlXyU7DhUYWdja2X/zqj7W24Aq5
7dEKm3fqqxK5XCFVGY5HI0cRsdENyTP7lxSiiTRYj2mlPedheCn+k6T5y0U4Xr40
FXwWb2nWqCF1AgIudhgvVbxlvqcxUm8Zz7yDeJ0JFovXQhyO5fLUHRLCQFssAbf8
B4i8rYYsBUhYTspVJcxVpIIltkYpdIRSIARA49HNvKK4hzjzMS/OhKQpVKw+OCEZ
xptCVeN2pjbdt9uzi175oVo/u6B2ArKAW17u6XEHIdDMOe7cb33peVI6TD15W4MI
pyQPbp8orlXe+tA8JA==
-----END CERTIFICATE-----`;

function exactArrayBuffer(value: ArrayBufferView | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function pkijsCertificate(raw: ArrayBuffer): Certificate {
  const parsed = asn1js.fromBER(raw);
  if (parsed.offset === -1) throw new Error("Certificate is invalid DER");
  return new Certificate({ schema: parsed.result });
}

function certificateFromPem(pem: string): Certificate {
  return pkijsCertificate(PemConverter.decodeFirst(pem));
}

function octetStringBytes(value: asn1js.OctetString): Uint8Array {
  if (!value.valueBlock.isConstructed) {
    return new Uint8Array(value.valueBlock.valueHexView);
  }
  const parts = value.valueBlock.value.map((entry) =>
    octetStringBytes(entry as asn1js.OctetString),
  );
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function sha256(value: string | Uint8Array | ArrayBuffer): string {
  const bytes =
    typeof value === "string"
      ? Buffer.from(value)
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function randomEnrollmentToken(): string {
  return randomBytes(32).toString("base64url");
}

export type GeneratedProfileSigner = {
  certificatePem: string;
  privateKeyPem: string;
  fingerprint: string;
  createdAt: Date;
  expiresAt: Date;
};

export async function generateProfileSigner(
  organizationName: string,
  now = new Date(),
): Promise<GeneratedProfileSigner> {
  const keys = (await webcrypto.subtle.generateKey(
    PROFILE_KEY_ALGORITHM,
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const createdAt = new Date(now.getTime() - 60_000);
  const expiresAt = new Date(now);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 10);
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: `CN=${organizationName.replaceAll(/[,+="<>#;]/g, "_")} Device Enrollment`,
      keys,
      notBefore: createdAt,
      notAfter: expiresAt,
      signingAlgorithm: PROFILE_KEY_ALGORITHM,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        await SubjectKeyIdentifierExtension.create(
          keys.publicKey,
          false,
          x509Crypto,
        ),
      ],
    },
    x509Crypto,
  );
  const privateKey = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  const fingerprint = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", certificate.rawData),
  )
    .toString("hex")
    .toUpperCase();
  return {
    certificatePem: certificate.toString("pem"),
    privateKeyPem: PemConverter.encode(privateKey, "PRIVATE KEY"),
    fingerprint,
    createdAt,
    expiresAt,
  };
}

export async function signMobileConfig(
  xml: string,
  certificatePem: string,
  privateKeyPem: string,
): Promise<Uint8Array> {
  const certificate = certificateFromPem(certificatePem);
  const privateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    PemConverter.decodeFirst(privateKeyPem),
    PROFILE_KEY_ALGORITHM,
    false,
    ["sign"],
  );
  const content = encoder.encode(xml);
  const signedData = new SignedData({
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: ContentInfo.DATA,
      eContent: new asn1js.OctetString({
        valueHex: exactArrayBuffer(content),
      }),
    }),
    signerInfos: [
      new SignerInfo({
        sid: new IssuerAndSerialNumber({
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
        }),
      }),
    ],
    certificates: [certificate],
  });
  await signedData.sign(
    privateKey as unknown as CryptoKey,
    0,
    "SHA-256",
    undefined,
    pkijsCrypto,
  );
  const contentInfo = new ContentInfo({
    contentType: ContentInfo.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}

export async function verifyAppleDeviceResponse(
  cmsBytes: Uint8Array,
  trustedCaPem = APPLE_IPHONE_DEVICE_CA_PEM,
): Promise<string> {
  const contentInfo = ContentInfo.fromBER(exactArrayBuffer(cmsBytes));
  if (contentInfo.contentType !== ContentInfo.SIGNED_DATA) {
    throw new Error("Device response is not CMS SignedData");
  }
  const signedData = new SignedData({ schema: contentInfo.content });
  if (signedData.signerInfos.length !== 1) {
    throw new Error("Device response must contain one signer");
  }
  const verified = await signedData.verify(
    { signer: 0, checkChain: false, extendedMode: true },
    pkijsCrypto,
  );
  if (verified.signatureVerified !== true || !verified.signerCertificate) {
    throw new Error("Device response CMS signature is invalid");
  }
  const trustedCa = certificateFromPem(trustedCaPem);
  if (!(await verified.signerCertificate.verify(trustedCa, pkijsCrypto))) {
    throw new Error("Device identity was not issued by Apple iPhone Device CA");
  }
  const content = signedData.encapContentInfo.eContent;
  if (!(content instanceof asn1js.OctetString)) {
    throw new Error("Device response does not contain an XML plist");
  }
  return decoder.decode(octetStringBytes(content));
}
