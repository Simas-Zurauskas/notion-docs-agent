const fs = require('fs');
const path = require('path');

function extractHeadings(markdown) {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.trim())
    .join('\n');
}

function loadDocsIndex(indexPath) {
  if (fs.existsSync(indexPath)) {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  return [];
}

function buildDocsOutline(docsIndex, baseDir) {
  const parts = [];
  for (const doc of docsIndex) {
    const filePath = path.resolve(baseDir, doc.file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const headings = extractHeadings(content);
    parts.push(`---\n\n"${doc.title}" (${doc.path}) [${doc.id}]\n${headings || '(no headings)'}`);
  }
  return parts.join('\n\n');
}

function loadPageContent(pageId, docsIndex, baseDir) {
  if (!pageId) return '';
  const entry = docsIndex.find((d) => d.id === pageId);
  if (!entry?.file) return '';
  const filePath = path.resolve(baseDir, entry.file);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  return '';
}

module.exports = { extractHeadings, loadDocsIndex, buildDocsOutline, loadPageContent };
