import { cpSync, existsSync, mkdirSync } from 'node:fs'

const source = 'node_modules/@mediapipe/tasks-vision/wasm'
const destination = 'public/mediapipe'
if (existsSync(source) && !existsSync(`${destination}/vision_wasm_internal.wasm`)) {
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true })
  console.log('Prepared local hand-tracking assets.')
}
