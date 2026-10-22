/** Deterministic, dependency-free plugin icons: a monogram on a hashed gradient. */

/** XML-escape text for an attribute or text node. */
function escapeXml(text) {
  return text.replace(/[<>&"']/gu, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

/** First letter or digit of the package's short name, the glyph of the generated icon. */
export function iconGlyph(name) {
  const short = name.slice(name.lastIndexOf('/') + 1);
  const match = /[a-z0-9]/iu.exec(short);
  return match === null ? '?' : match[0].toUpperCase();
}

/**
 * Render a 64x64 SVG icon for a package. The hue comes from the name, so a rebuild without
 * changes produces byte-identical output and an added plugin never shifts another's colour.
 */
export function monogramSvg(name) {
  let hash = 7;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  const second = (hue + 38) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(name)}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 68% 56%)"/>
      <stop offset="1" stop-color="hsl(${second} 66% 40%)"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <text x="32" y="42" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="30" font-weight="600" fill="#fff">${escapeXml(iconGlyph(name))}</text>
</svg>
`;
}

/** Content type for the image extensions the index format accepts. */
export function imageContentType(file) {
  const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    default: return undefined;
  }
}
