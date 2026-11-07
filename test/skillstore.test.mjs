import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { canonicalJson, verifySkillStoreManifest } from '../src/sources/skillstore-signature.js'
import { resolve as resolveSkillStore } from '../src/sources/skillstore.js'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function signedManifest() {
  const signed = {
    kind: 'skill',
    skill: {
      slug: 'acme-pdf',
      name: 'pdf',
      treeHash: 'a'.repeat(64),
    },
    artifact: {
      type: 'skill-zip',
      source: {
        type: 'github',
        owner: 'acme',
        repo: 'skills',
        ref: COMMIT,
        commit: COMMIT,
        path: 'skills/pdf',
      },
      sha256: 'b'.repeat(64),
    },
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const value = crypto.sign(null, Buffer.from(JSON.stringify(canonicalJson(signed))), privateKey).toString('base64url')
  return {
    signed,
    signature: {
      algorithm: 'Ed25519',
      keyId: 'test-key',
      publicKeyJwk: publicKey.export({ format: 'jwk' }),
      signedAt: '2026-01-01T00:00:00.000Z',
      value,
    },
  }
}

test('SkillStore manifests verify Ed25519 signatures and pin immutable GitHub coordinates', () => {
  const verified = verifySkillStoreManifest(signedManifest(), { expectedSlug: 'acme-pdf' })
  assert.equal(verified.ok, true)
  assert.equal(verified.repo, 'acme/skills')
  assert.equal(verified.ref, COMMIT)
  assert.equal(verified.path, 'skills/pdf')
  assert.equal(verified.artifactSha256, 'b'.repeat(64))
})

test('SkillStore verification rejects payload tampering and slug mismatches', () => {
  const manifest = signedManifest()
  manifest.signed.artifact.source.repo = 'attacker/skills'
  assert.throws(
    () => verifySkillStoreManifest(manifest, { expectedSlug: 'acme-pdf' }),
    (err) => err.code === 'ESKILLSTORE_SIGNATURE' && /signature is invalid/.test(err.message),
  )
  assert.throws(
    () => verifySkillStoreManifest(signedManifest(), { expectedSlug: 'another-skill' }),
    /slug mismatch/,
  )
})

test('SkillStore resolve fetches and verifies its manifest before installation', async () => {
  const manifest = signedManifest()
  const calls = []
  const http = async (url) => {
    calls.push(String(url))
    const text = JSON.stringify(manifest)
    return {
      ok: true,
      status: 200,
      text: async () => text,
      json: async () => JSON.parse(text),
    }
  }
  const entry = await resolveSkillStore(
    {
      source: 'skillstore',
      id: 'skillstore:acme-pdf',
      key: 'acme-pdf',
      name: 'pdf',
      repo: 'untrusted/placeholder',
      installName: 'my-pdf',
    },
    { http, log: () => {} },
  )
  assert.deepEqual(calls, ['https://skillstore.io/api/skills/acme-pdf/manifest'])
  assert.equal(entry.repo, 'acme/skills')
  assert.equal(entry.path, 'skills/pdf')
  assert.equal(entry.verified, true)
  assert.equal(entry.installName, 'my-pdf')
})
