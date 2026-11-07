import assert from 'node:assert/strict'
import test from 'node:test'

import { searchAll } from '../src/sources/index.js'
import { search as searchSkillsMp } from '../src/sources/skillsmp.js'
import { search as searchSkillsSh } from '../src/sources/skillssh.js'
import { search as searchSkillStore } from '../src/sources/skillstore.js'

function jsonResponse(payload) {
  const text = JSON.stringify(payload)
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

test('SkillsMP adapter preserves GitHub coordinates and authorization', async () => {
  const calls = []
  const http = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return jsonResponse({
      data: {
        skills: [
          {
            id: 'pdf-1',
            name: 'pdf',
            description: 'PDF workflows',
            githubUrl: 'https://github.com/acme/skills/tree/main/skills/pdf',
            stars: 12,
          },
        ],
      },
    })
  }
  const entries = await searchSkillsMp(
    { query: 'pdf', limit: 5 },
    { http, tokens: { skillsmp: 'secret-token' }, log: () => {} },
  )
  assert.equal(entries[0].repo, 'acme/skills')
  assert.equal(entries[0].path, 'skills/pdf')
  assert.equal(calls[0].headers.authorization, 'Bearer secret-token')
})

test('skills.sh and SkillStore adapters normalize search rows', async () => {
  const skillsSh = await searchSkillsSh(
    { query: 'pdf', limit: 5 },
    {
      http: async () => jsonResponse({
        skills: [{ id: 'acme/skills/pdf', source: 'acme/skills', skillId: 'pdf', name: 'pdf', installs: 42 }],
      }),
      log: () => {},
    },
  )
  assert.equal(skillsSh[0].repo, 'acme/skills')
  assert.equal(skillsSh[0].installs, 42)

  const skillStore = await searchSkillStore(
    { query: 'pdf', limit: 5 },
    {
      http: async () => jsonResponse({
        data: [{
          slug: 'acme-pdf',
          displayName: 'PDF',
          description: 'PDF workflows',
          repo: 'https://github.com/acme/skills/tree/main/skills/pdf',
          riskLevel: 'medium',
          stats: { downloadCount: 7 },
        }],
      }),
      log: () => {},
    },
  )
  assert.equal(skillStore[0].repo, 'acme/skills')
  assert.equal(skillStore[0].risk, 'medium')
  assert.equal(skillStore[0].installs, 7)
})

test('searchAll isolates source failures and still returns successful results', async () => {
  const outcome = await searchAll(
    { query: 'pdf', sources: ['skillsmp', 'skillssh'], limit: 5 },
    {
      http: async (url) => {
        if (String(url).includes('skillsmp.com')) throw new Error('skillsmp unavailable')
        return jsonResponse({
          skills: [{ id: 'acme/skills/pdf', source: 'acme/skills', skillId: 'pdf', name: 'pdf', installs: 5 }],
        })
      },
      tokens: {},
      log: () => {},
    },
  )
  assert.equal(outcome.items.length, 1)
  assert.deepEqual(
    outcome.reports.map((report) => [report.source, report.ok]),
    [['skillsmp', false], ['skillssh', true]],
  )
})
