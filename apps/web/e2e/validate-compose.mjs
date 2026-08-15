import { load } from 'js-yaml'
import { readFileSync } from 'node:fs'
const doc = load(readFileSync('docker-compose.yml', 'utf8'))
console.log(JSON.stringify(doc, null, 2))
