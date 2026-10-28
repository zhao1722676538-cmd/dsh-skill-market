/**
 * 纯 JSDoc typedef，无运行时代码。见 SPEC.md §2。
 * @module dsh-skill-market/types
 */

/** @typedef {'skillsmp'|'skillstore'|'skillssh'|'github'} SourceId */

/**
 * @typedef {Object} SkillEntry
 * @property {SourceId} source
 * @property {string} id
 * @property {string} name
 * @property {string} [title]
 * @property {string} description
 * @property {string} [author]
 * @property {string} [repo]
 * @property {string} [ref]
 * @property {string} [path]
 * @property {string} [url]
 * @property {number} [installs]
 * @property {number} [stars]
 * @property {string} [risk]
 * @property {string[]} [tags]
 */

/**
 * @typedef {Object} SearchQuery
 * @property {string} query
 * @property {SourceId[]} [sources]
 * @property {number} [limit]
 * @property {number} [page]
 * @property {AbortSignal} [signal]
 * @property {(ev:{source:SourceId,ms:number,count?:number,error?:string}) => void} [onSource]
 */

/**
 * @typedef {Object} SourceReport
 * @property {SourceId} source
 * @property {boolean} ok
 * @property {number} [count]
 * @property {string} [error]
 * @property {number} ms
 */

/**
 * @typedef {Object} SearchOutcome
 * @property {SkillEntry[]} items
 * @property {SourceReport[]} reports
 */

/**
 * @typedef {Object} SourceDeps
 * @property {(input:string|URL, init?:RequestInit & {timeoutMs?:number}) => Promise<Response>} http
 * @property {{skillsmp?:string, github?:string}} tokens
 * @property {(msg:string) => void} log
 */

/**
 * @typedef {Object} InstalledSkill
 * @property {string} name
 * @property {SourceId} source
 * @property {string} id
 * @property {string} [repo]
 * @property {string} [ref]
 * @property {string} [commit]
 * @property {string} [path]
 * @property {string} installedAt
 * @property {{path:string,sha256:string,size:number}[]} files
 */

export {}
