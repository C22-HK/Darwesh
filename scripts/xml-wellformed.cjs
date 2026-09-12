// Well-formedness checks for the small, hand-generated XML this repo ships
// (today: sitemap.xml).
//
// WHY THIS EXISTS
// ---------------
// sitemap.xml shipped to production with `--` inside an XML comment. XML
// forbids that, and the failure is not local: the parser rejects the WHOLE
// document, so a stray hyphen in a comment silently discards every URL in
// the sitemap. Nothing caught it, because the check that "validated" the
// sitemap read it with regular expressions -- which are perfectly happy
// with XML that no parser will accept.
//
// So: anything that generates or checks XML here runs it through this
// first. CommonJS on purpose, so both scripts/ci-checks.js (require) and
// scripts/generate-sitemap.mjs (createRequire) use the same code rather
// than two drifting copies.
//
// This is deliberately NOT a general XML parser. It checks the mistakes
// that are actually reachable in generated markup -- comment syntax, tag
// balance, and unescaped text -- and it is exact about those. Constructs
// this repo's XML never contains (DTDs, CDATA, namespaced prefixes,
// custom entities) are out of scope; see assertNoUnsupportedConstructs.

/** Line/column of an absolute offset, 1-based, the way parsers report it. */
function positionOf(text, index) {
  const before = text.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function at(text, index, message) {
  const { line, column } = positionOf(text, index);
  return { line, column, message };
}

/** Constructs this checker does not model. Their presence means the file
 *  has outgrown this checker, which must be a loud failure rather than a
 *  quiet pass. */
function assertNoUnsupportedConstructs(xml, errors) {
  const unsupported = [
    ['<!DOCTYPE', 'a DOCTYPE/DTD'],
    ['<![CDATA[', 'a CDATA section'],
  ];
  unsupported.forEach(([token, label]) => {
    const i = xml.indexOf(token);
    if (i !== -1) {
      errors.push(at(xml, i, `${label} is present; this checker does not model it -- validate with a real XML parser instead`));
    }
  });
}

/** XML comments: `--` may not appear inside one, and one may not end with
 *  `-` (that would make the terminator `--->`). Both are fatal. */
function checkComments(xml, errors) {
  let i = 0;
  while (true) {
    const start = xml.indexOf('<!--', i);
    if (start === -1) break;
    const end = xml.indexOf('-->', start + 4);
    if (end === -1) {
      errors.push(at(xml, start, 'unterminated XML comment (no matching "-->")'));
      break;
    }
    const body = xml.slice(start + 4, end);
    const bad = body.indexOf('--');
    if (bad !== -1) {
      errors.push(at(xml, start + 4 + bad,
        'a double hyphen "--" inside an XML comment is forbidden and makes the ENTIRE document unparseable'));
    }
    if (body.endsWith('-')) {
      errors.push(at(xml, end - 1, 'an XML comment may not end with "-" immediately before "-->"'));
    }
    i = end + 3;
  }
}

/** Everything outside comments and the XML declaration: tags must balance
 *  and nest, and text must not contain a bare `<` or an unescaped `&`. */
function checkTagsAndText(xml, errors) {
  // Blank out comments and the declaration, preserving offsets so reported
  // positions still point at the real file.
  let scan = xml.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  scan = scan.replace(/<\?[\s\S]*?\?>/g, (m) => ' '.repeat(m.length));

  const stack = [];
  const tagRe = /<\/?([A-Za-z_][\w.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let lastEnd = 0;
  let m;
  while ((m = tagRe.exec(scan)) !== null) {
    // Text between the previous tag and this one.
    const text = scan.slice(lastEnd, m.index);
    const lt = text.indexOf('<');
    if (lt !== -1) errors.push(at(xml, lastEnd + lt, 'a bare "<" in text must be written "&lt;"'));
    for (const am of text.matchAll(/&(#\d+|#x[0-9A-Fa-f]+|[A-Za-z][\w.-]*)?;?/g)) {
      const ok = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);$/.test(am[0]);
      if (!ok) errors.push(at(xml, lastEnd + am.index, `"${am[0]}" is not a valid entity reference; a literal "&" must be written "&amp;"`));
    }

    const name = m[1];
    const selfClosing = m[2].trimEnd().endsWith('/');
    if (m[0].startsWith('</')) {
      const open = stack.pop();
      if (open === undefined) {
        errors.push(at(xml, m.index, `closing tag </${name}> with nothing open`));
      } else if (open.name !== name) {
        errors.push(at(xml, m.index, `closing tag </${name}> does not match still-open <${open.name}>`));
      }
    } else if (!selfClosing) {
      stack.push({ name, index: m.index });
    }
    lastEnd = m.index + m[0].length;
  }
  // Trailing text after the last tag.
  const tail = scan.slice(lastEnd);
  const tailLt = tail.indexOf('<');
  if (tailLt !== -1) errors.push(at(xml, lastEnd + tailLt, 'a bare "<" in text must be written "&lt;"'));

  stack.forEach((open) => {
    errors.push(at(xml, open.index, `<${open.name}> is never closed`));
  });
}

/**
 * Returns an array of {line, column, message}. Empty means no problem
 * found among the constructs this checker models.
 */
function findXmlErrors(xml) {
  const errors = [];
  assertNoUnsupportedConstructs(xml, errors);
  checkComments(xml, errors);
  checkTagsAndText(xml, errors);
  return errors.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Makes `text` safe to place inside an XML comment, so a comment can never
 * be built that breaks the document. Collapses runs of hyphens and drops
 * any trailing hyphen. Use this instead of interpolating prose directly:
 * the point is that no future wording choice can reintroduce the bug.
 */
function safeCommentText(text) {
  return String(text)
    .replace(/-{2,}/g, '-')
    .replace(/-+(?=\s*$)/, '');
}

/** Builds a complete, always-valid XML comment from arbitrary prose. */
function xmlComment(text) {
  return `<!--\n${safeCommentText(text)}\n-->`;
}

module.exports = { findXmlErrors, safeCommentText, xmlComment, positionOf };
