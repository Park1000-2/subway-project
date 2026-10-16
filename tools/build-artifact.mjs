/**
 * index.html → dist/artifact.html
 * Claude Artifact 는 <head>/<body> 골격을 자동으로 감싸므로 본문만 떼어냅니다.
 * 사용: node tools/build-artifact.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

const pick = (re) => (html.match(re) ?? [''])[0];
const head = [
  pick(/<title>[\s\S]*?<\/title>/),
  ...(html.match(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g) ?? []),
  pick(/<style>[\s\S]*?<\/style>/),
].join('\n');
const body = html
  .replace(/[\s\S]*?<body[^>]*>/, '')
  .replace(/<\/body>[\s\S]*/, '')
  .replace('src="./src/app.js"', 'src="src/app.js"');

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/artifact.html'), `${head}\n${body}\n`);
console.log('dist/artifact.html 생성 완료');
