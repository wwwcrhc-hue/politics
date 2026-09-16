'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const explicitFiles = ['server.js'];
const directories = ['public', 'src'];

function collectJsFiles(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];

  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap(entry => {
    const relativePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(relativePath);
    return entry.isFile() && entry.name.endsWith('.js') ? [relativePath] : [];
  });
}

const files = [...explicitFiles, ...directories.flatMap(collectJsFiles)];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
