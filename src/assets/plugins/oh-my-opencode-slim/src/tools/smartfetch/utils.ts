import { Readability } from '@mozilla/readability';
import type { VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { escapeHtml } from '../../utils/escape-html';
import { parseFrontmatter } from '../../utils/frontmatter';
import { type JsdomModule, loadJSDOM } from '../../utils/jsdom';
import type { CachedFetch, ExtractedContent } from './types';

const CSS_TREE_WARN_PREFIX = '[csstree-match]';
const BLOCK_TAGS =
  /^(?:ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|DT|DD|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL)$/;

/**
 * Suppresses css-tree lexer warnings ([csstree-match] prefix) emitted
 * synchronously during JSDOM construction (jsdom uses css-tree to parse
 * stylesheets; css-tree calls the global console.warn directly, bypassing
 * jsdom's virtualConsole). Other warnings pass through untouched.
 */
export function withCssTreeWarningsSuppressed<T>(fn: () => T): T {
  const originalWarn = console.warn;
  console.warn = ((...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (!first.startsWith(CSS_TREE_WARN_PREFIX)) originalWarn(...args);
  }) as typeof console.warn;
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Suppresses jsdom "css-parsing" errors ("Could not parse CSS stylesheet")
 * that jsdom would otherwise forward to console.error when no custom
 * virtualConsole is supplied, leaking parser noise into the TUI. Other
 * jsdomErrors pass through to console.error as full error objects,
 * preserving stack, cause, and URL metadata.
 */
export function withJsdomCssParsingErrorsSuppressed<T>(
  fn: (vc: VirtualConsole) => T,
  VirtualConsoleClass: JsdomModule['VirtualConsole'],
): T {
  const vc = new VirtualConsoleClass();
  vc.on('jsdomError', (error) => {
    const type = (error as Error & { type?: string }).type;
    if (type !== 'css-parsing') console.error(error);
  });
  return fn(vc);
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function byteLength(text: string) {
  return Buffer.byteLength(text || '', 'utf8');
}

function quote(value: unknown) {
  return JSON.stringify(value ?? '');
}

export function frontmatter(metadata: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quote(item)}`);
      continue;
    }
    lines.push(`${key}: ${quote(value)}`);
  }
  lines.push('---', '', '');
  return lines.join('\n');
}

export function trimBlankRuns(input: string): string {
  return input.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanExtractedText(input: string) {
  return trimBlankRuns(input);
}

function mapOutsideCodeBlocks(
  input: string,
  transform: (value: string) => string,
) {
  const parts = input.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}

function extractStructuredText(root: Element | null) {
  if (!root) return '';
  const chunks: string[] = [];
  const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const isText = (node: Node) => node.nodeType === node.TEXT_NODE;
  const isElement = (node: Node) => node.nodeType === node.ELEMENT_NODE;
  const pushText = (value: string) => {
    const normalized = value.replace(/\s+/g, ' ');
    if (!normalized.trim()) return;
    const previous = chunks[chunks.length - 1];
    if (!previous || /\n$| $/.test(previous)) {
      chunks.push(normalized.trimStart());
    } else {
      chunks.push(normalized);
    }
  };
  const pushBreak = (count = 1) => {
    const wanted = '\n'.repeat(count);
    const last = chunks[chunks.length - 1] || '';
    const trailing = last.match(/\n+$/)?.[0].length || 0;
    if (trailing >= count) return;
    if (trailing > 0) {
      chunks[chunks.length - 1] = last.replace(/\n+$/, '') + wanted;
      return;
    }
    chunks.push(wanted);
  };
  const visit = (node: Node) => {
    if (isText(node)) {
      pushText(node.textContent || '');
      return;
    }
    if (!isElement(node)) return;
    const element = node as Element;
    const tag = element.tagName;
    if (ignoredTags.has(tag)) return;
    if (tag === 'BR') {
      pushBreak(1);
      return;
    }
    if (tag === 'PRE') {
      const text = trimBlankRuns(element.textContent || '');
      if (!text) return;
      pushBreak(2);
      chunks.push(text);
      pushBreak(2);
      return;
    }
    const isBlock = BLOCK_TAGS.test(tag);
    if (isBlock) pushBreak(tag === 'LI' ? 1 : 2);
    if (tag === 'LI') chunks.push('- ');
    for (const child of element.childNodes) visit(child);
    if (isBlock) pushBreak(tag === 'LI' ? 1 : 2);
  };
  visit(root);
  return cleanExtractedText(chunks.join(''));
}

function cleanHeadingText(input: string): string {
  const normalized = trimBlankRuns(input)
    .replace(/(?<!¶)¶+$/, '')
    .trim();
  if (/^(?:C|F)#$/.test(normalized)) return normalized;
  if (/\s#+$/.test(normalized)) {
    return normalized.replace(/\s#+$/g, '').trim();
  }
  return normalized;
}

export function cleanFetchedMarkdown(input: string): string {
  const PL = '"Permanent link")';
  const output = mapOutsideCodeBlocks(input, (value) =>
    value
      .split('\n')
      .map((line) => {
        let cleaned = line
          .replace(/^[^\S\n]*!\[[^\]]*\]\([^)]+\)[^\S\n]*$/, 'Image omitted')
          .replace(/^Image$/, 'Image omitted')
          .replace(
            /^[^\S\n]*(#{1,6})[^\S\n]*\\?\['([^'\n]+)'[^\S\n]*$/,
            '$1 $2',
          )
          .replace(/^[^\S\n]*(#{1,6})[^\S\n]*'([^'\n]+)'\][^\S\n]*$/, '$1 $2')
          .replace(/^[^\S\n]*(#{1,6})[^\S\n]*'([^'\n]+)'[^\S\n]*$/, '$1 $2');
        const p = cleaned.startsWith('#') ? cleaned.indexOf('[¶](#', 1) : -1;
        if (p !== -1) {
          const t = cleaned.lastIndexOf(PL);
          if (
            t >= p + 5 &&
            /^[^\S\n]*$/.test(cleaned.slice(t + PL.length)) &&
            !/[\r\u2028\u2029]/.test(cleaned.slice(0, t))
          )
            cleaned = cleaned.slice(0, p).trimEnd();
        }
        return cleaned.replace(
          /(?<![^\S\n])[^\S\n]+\(#[A-Za-z0-9_-]+\)[^\S\n]*$/,
          '',
        );
      })
      .join('\n'),
  );

  return trimBlankRuns(output);
}

export function cleanFetchedText(input: string): string {
  return trimBlankRuns(input);
}

export function joinRenderedContent(
  metadata: string,
  content: string,
  format: 'text' | 'markdown' | 'html',
): string {
  if (!metadata) return content;
  if (!content) {
    return format === 'html' ? `<!--\n${metadata.trim()}\n-->` : metadata;
  }
  if (format === 'html') {
    const comment = `<!--\n${metadata.trim()}\n-->\n`;
    const xmlDecl = content.match(/^\s*(<\?xml[\s\S]*?\?>\s*)/i);
    if (xmlDecl) {
      return `${xmlDecl[1]}${comment}${content.slice(xmlDecl[0].length)}`;
    }
    return `${comment}${content}`;
  }
  const startsWithFrontmatter = /^---(?:\r?\n|$)/.test(content);
  if (!startsWithFrontmatter) return `${metadata}${content}`;
  return `${metadata}Source content:\n\n${content}`;
}

export function renderMessageForFormat(
  content: string,
  format: 'text' | 'markdown' | 'html',
): string {
  if (format === 'html') return `<pre>${escapeHtml(content)}</pre>`;
  return content;
}

export function buildRedirectResultMessage(
  originalUrl: string,
  redirectUrl: string,
  statusCode: number,
) {
  return [
    'Redirect was blocked by policy.',
    `Original URL: ${originalUrl}`,
    `Redirect URL: ${redirectUrl}`,
    `Status: ${statusCode}`,
    '',
    'Re-run webfetch with the redirect URL to continue.',
  ].join('\n');
}

export function buildLlmsRequiredMessage(originalUrl: string, reason?: string) {
  return [
    'Required llms.txt content was unavailable.',
    `Original URL: ${originalUrl}`,
    ...(reason ? [`Reason: ${reason}`] : []),
  ].join('\n');
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'noscript', 'meta', 'link']);
turndown.remove(
  (node: unknown) =>
    (node as Element).nodeName === 'A' &&
    /permanent link/i.test((node as Element).getAttribute('title') || ''),
);
turndown.addRule('fenced-pre-code', {
  filter(node: unknown) {
    return (
      (node as Element).nodeName === 'PRE' &&
      !!(node as Element).querySelector('code')
    );
  },
  replacement(_content: string, node: unknown) {
    const code = (node as Element).querySelector('code');
    const text = trimBlankRuns(
      code?.textContent || (node as Element).textContent || '',
    );
    if (!text) return '';
    return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
  },
});

export async function extractFromHtml(
  html: string,
  finalUrl: string,
  extractMain: boolean,
): Promise<ExtractedContent> {
  const { JSDOM, VirtualConsole } = await loadJSDOM();
  const createDom = () =>
    withCssTreeWarningsSuppressed(() =>
      withJsdomCssParsingErrorsSuppressed(
        (vc) => new JSDOM(html, { url: finalUrl, virtualConsole: vc }),
        VirtualConsole,
      ),
    );
  const dom = createDom();
  const document = dom.window.document;
  const title = document.title || undefined;
  const canonical =
    document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
    undefined;
  const canonicalUrl =
    canonical && URL.canParse(canonical, finalUrl)
      ? new URL(canonical, finalUrl).toString()
      : undefined;
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>('h1, h2, h3'),
  )
    .map((node) => cleanHeadingText(node.textContent || ''))
    .filter(Boolean)
    .slice(0, 12);

  let fallbackDocument = document;
  if (extractMain) {
    // Readability mutates its document. Check the size before invoking it so
    // very large pages fall back to the original document instead of blocking.
    if (document.getElementsByTagName('*').length <= 15_000) {
      const article = new Readability<Element>(document, {
        serializer: (node) => node as Element,
      }).parse();
      const articleContent = article?.content;
      const articleHtml = articleContent?.innerHTML;
      if (articleContent && articleHtml?.trim()) {
        const reparsed = document.createElement('div');
        reparsed.innerHTML = articleHtml;
        return {
          title: article?.title || title,
          rawContent: html,
          html: articleHtml,
          text: extractStructuredText(reparsed),
          markdown: trimBlankRuns(turndown.turndown(articleHtml)),
          extractedMain: true,
          canonicalUrl,
          headings,
        };
      }
      // A failed Readability attempt may have changed the DOM; restore it.
      fallbackDocument = createDom().window.document;
    }
  }

  const bodyHtml = fallbackDocument.body?.innerHTML || html;
  const bodyText = extractStructuredText(fallbackDocument.body);
  const markdown = trimBlankRuns(turndown.turndown(bodyHtml));
  return {
    title,
    rawContent: html,
    html,
    text: bodyText,
    markdown,
    extractedMain: false,
    canonicalUrl,
    headings,
  };
}

export function inferCanonicalUrlFromText(content: string, finalUrl: string) {
  const frontmatterData = parseFrontmatter(content);
  const raw = frontmatterData?.url;
  return raw && URL.canParse(raw, finalUrl)
    ? new URL(raw, finalUrl).toString()
    : undefined;
}

export function extractHeadingsFromMarkdown(content: string) {
  const headings = content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => cleanHeadingText(line.replace(/^#{1,6}\s+/, '')))
    .filter(Boolean)
    .slice(0, 12);
  return headings.length ? headings : undefined;
}

export function detectQualitySignals(
  fetchResult: Pick<
    CachedFetch,
    | 'text'
    | 'markdown'
    | 'rawContent'
    | 'wordCount'
    | 'sourceKind'
    | 'extractedMain'
  >,
) {
  const signals = new Set<string>();
  const text = `${fetchResult.text}\n${fetchResult.markdown}`;

  if (fetchResult.wordCount > 0 && fetchResult.wordCount < 60) {
    signals.add('very_short_content');
  }

  if (
    /(subscribe to continue|subscription required|sign in to continue|log in to continue|create an account to continue|members only|premium content|paywall)/i.test(
      text,
    )
  ) {
    signals.add('possible_paywall');
  }

  if (fetchResult.sourceKind === 'html') {
    const renderedBytes = Math.max(byteLength(fetchResult.text), 1);
    const rawBytes = byteLength(fetchResult.rawContent);
    const ratio = rawBytes / renderedBytes;
    if (
      !fetchResult.extractedMain &&
      ratio >= 10 &&
      fetchResult.wordCount < 1200
    ) {
      signals.add('high_boilerplate_ratio');
    }
  }

  return [...signals];
}
