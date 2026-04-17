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

/**
 * Return the immediate children of a page by walking docsIndex segments.
 * A child's segments are the parent's segments + exactly one more segment.
 */
function findChildren(pageId, docsIndex) {
  if (!pageId || !Array.isArray(docsIndex)) return [];
  const parent = docsIndex.find((d) => d.id === pageId);
  if (!parent?.segments || !parent.segments.length) return [];
  const depth = parent.segments.length;
  return docsIndex.filter((d) => {
    if (!d.segments || d.segments.length !== depth + 1) return false;
    for (let i = 0; i < depth; i++) {
      if (d.segments[i] !== parent.segments[i]) return false;
    }
    return true;
  });
}

/**
 * Build a compact excerpt of each child page's current content, suitable for
 * injection into a hub-page worker prompt.
 *
 * The worker reads this BEFORE writing the hub so its summary aligns with
 * what the children actually say today. Excerpts are truncated to keep the
 * prompt bounded — one child can easily be thousands of tokens.
 */
function loadChildrenContext(pageId, docsIndex, baseDir, { maxCharsPerChild = 1200, maxChildren = 12 } = {}) {
  const children = findChildren(pageId, docsIndex);
  if (!children.length) return { count: 0, text: '' };
  const clipped = children.slice(0, maxChildren);
  const parts = [];
  for (const child of clipped) {
    const body = loadPageContent(child.id, docsIndex, baseDir);
    // Trim leading whitespace so the snapshot starts at the first line of real content.
    const trimmed = body.replace(/^\s+/, '');
    const excerpt = trimmed.length > maxCharsPerChild
      ? `${trimmed.slice(0, maxCharsPerChild)}\n\n... (child page truncated; full content at page id ${child.id})`
      : trimmed;
    parts.push(`### Child: "${child.title}" [${child.id}]\n\n${excerpt || '(no content fetched)'}`);
  }
  const skipped = children.length - clipped.length;
  const footer = skipped > 0 ? `\n\n_(${skipped} more child page(s) omitted for brevity.)_` : '';
  return { count: children.length, text: parts.join('\n\n---\n\n') + footer };
}

module.exports = { extractHeadings, loadDocsIndex, buildDocsOutline, loadPageContent, findChildren, loadChildrenContext };
