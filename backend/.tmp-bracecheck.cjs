const fs = require('fs')
const path = require('path')
const s = fs.readFileSync(path.join(process.cwd(), 'src', 'seed', 'seed.ts'), 'utf8')
const lines = s.split(/\r?\n/)
const stack = [] // line numbers of open '{'
let inStr = null
let inTpl = false
let tplDepth = 0
let inLineComment = false
let inBlockComment = false
let depth = 0
let stray = []
for (let idx = 0; idx < lines.length; idx++) {
  const line = lines[idx]
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    const next = line[i + 1]
    if (inLineComment) { i = line.length; continue }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue }
      i += 1; continue
    }
    if (inStr) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inStr) inStr = null
      i += 1; continue
    }
    if (inTpl) {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { inTpl = false; i += 1; continue }
      if (ch === '}' && tplDepth === 0) { inTpl = false; depth -= 1; i += 1; continue }
      if (ch === '{') { tplDepth += 1; i += 1; continue }
      if (ch === '}') { tplDepth -= 1; i += 1; continue }
      i += 1; continue
    }
    if (ch === '/' && next === '/') { i = line.length; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === '`') { inTpl = true }
      else inStr = ch
      i += 1; continue
    }
    if (ch === '{') { depth += 1; stack.push(idx + 1); i += 1; continue }
    if (ch === '}') {
      depth -= 1
      if (stack.length) stack.pop()
      else stray.push(idx + 1)
      i += 1; continue
    }
    i += 1
  }
}
console.log('FINAL DEPTH:', depth)
console.log('UNCLOSED { opened at lines:', stack.join(', ') || '(none)')
console.log('STRAY } at lines:', stray.join(', ') || '(none)')
