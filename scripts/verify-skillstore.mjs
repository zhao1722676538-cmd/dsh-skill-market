#!/usr/bin/env node
import { verifySkillStoreManifest } from '../src/sources/skillstore-signature.js'

const slug = process.argv[2]
if (!slug) {
  console.error('usage: node scripts/verify-skillstore.mjs <skillstore-slug>')
  process.exit(2)
}

const response = await fetch(`https://skillstore.io/api/skills/${encodeURIComponent(slug)}/manifest`, {
  headers: { accept: 'application/json', 'user-agent': 'dsh-skill-market/0.1' },
})
if (!response.ok) {
  console.error(`SkillStore manifest request failed: HTTP ${response.status}`)
  process.exit(1)
}
const verified = verifySkillStoreManifest(await response.json(), { expectedSlug: slug })
console.log(JSON.stringify(verified, null, 2))
