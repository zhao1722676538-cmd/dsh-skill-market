import crypto from 'node:crypto'

/** @param {any} value */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    )
  }
  return value
}

/**
 * SkillStore signs the canonical-key order form of `manifest.signed` with
 * Ed25519. This checks artifact integrity; it does not claim that a skill is safe.
 * @param {any} manifest
 * @param {{expectedSlug?: string}} [options]
 */
export function verifySkillStoreManifest(manifest, options = {}) {
  const signature = manifest?.signature
  const signed = manifest?.signed
  if (!signed || !signature) throw verifyError('manifest is missing signed data or signature')
  if (String(signature.algorithm).toLowerCase() !== 'ed25519') {
    throw verifyError(`unsupported signature algorithm: ${signature.algorithm ?? 'missing'}`)
  }
  if (!signature.publicKeyJwk || typeof signature.publicKeyJwk !== 'object') {
    throw verifyError('manifest is missing a public Ed25519 key')
  }
  if (typeof signature.value !== 'string' || signature.value === '') {
    throw verifyError('manifest signature value is missing')
  }

  let valid = false
  try {
    const key = crypto.createPublicKey({ key: signature.publicKeyJwk, format: 'jwk' })
    valid = crypto.verify(
      null,
      Buffer.from(JSON.stringify(canonicalJson(signed)), 'utf8'),
      key,
      Buffer.from(signature.value, 'base64url'),
    )
  } catch (err) {
    throw verifyError(`manifest signature could not be checked: ${err?.message ?? err}`, err)
  }
  if (!valid) throw verifyError('manifest Ed25519 signature is invalid')
  if (signed.kind !== 'skill') throw verifyError(`unexpected signed kind: ${signed.kind ?? 'missing'}`)

  const slug = signed.skill?.slug
  if (options.expectedSlug && slug !== options.expectedSlug) {
    throw verifyError(`manifest slug mismatch: expected ${options.expectedSlug}, got ${slug ?? 'missing'}`)
  }

  const artifact = signed.artifact ?? {}
  const source = artifact.source ?? {}
  if (source.type !== 'github') throw verifyError(`unsupported artifact source: ${source.type ?? 'missing'}`)
  const owner = String(source.owner ?? '')
  const repo = String(source.repo ?? '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    throw verifyError('signed artifact source has an invalid GitHub repository')
  }
  const commit = String(source.commit ?? '')
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw verifyError('signed artifact source must pin a 40-hex commit')
  if (artifact.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(String(artifact.sha256))) {
    throw verifyError('signed artifact SHA-256 is invalid')
  }
  const sourcePath = typeof source.path === 'string' ? source.path.replace(/^\/+|\/+$/g, '') : ''
  if (
    sourcePath !== '' &&
    (sourcePath.includes('\\') ||
      sourcePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
  ) {
    throw verifyError('signed artifact source has an unsafe path')
  }

  return {
    ok: true,
    algorithm: 'Ed25519',
    keyId: typeof signature.keyId === 'string' ? signature.keyId : null,
    signedAt: typeof signature.signedAt === 'string' ? signature.signedAt : null,
    slug,
    repo: `${owner}/${repo}`,
    ref: commit.toLowerCase(),
    commit: commit.toLowerCase(),
    path: sourcePath || undefined,
    artifactSha256: typeof artifact.sha256 === 'string' ? artifact.sha256.toLowerCase() : null,
    treeHash: typeof signed.skill?.treeHash === 'string' ? signed.skill.treeHash : null,
  }
}

function verifyError(message, cause) {
  const error = new Error(`SkillStore manifest verification failed: ${message}`)
  error.code = 'ESKILLSTORE_SIGNATURE'
  if (cause) error.cause = cause
  return error
}

export default { canonicalJson, verifySkillStoreManifest }
