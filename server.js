import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_LINKS = 100;
const MAX_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

export const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/scrape') {
      await handleScrape(req, res);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'A server error occurred.' });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => {
    console.log(`SEDscraper running: http://${HOST}:${PORT}`);
  });
}

async function handleScrape(req, res) {
  const body = await readRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(body || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON.' });
    return;
  }

  const links = normalizeLinks(payload.links);

  if (!links.length) {
    sendJson(res, 400, { error: 'Provide at least one link.' });
    return;
  }

  if (links.length > MAX_LINKS) {
    sendJson(res, 400, { error: `Maximum ${MAX_LINKS} links per request.` });
    return;
  }

  const results = [];

  for (const link of links) {
    results.push(await scrapeLink(link));
  }

  sendJson(res, 200, { results });
}

async function scrapeLink(url) {
  try {
    const html = await fetchHtml(url);
    const meta = extractArticleMeta(html);
    const title = extractPostTitle(html);
    const featuredImage = extractFeaturedImage(html, url);
    const category = detectCategory({ url, title, meta });
    const postContent = extractPostContent(html);
    const powerPressLink = category === 'Podcast'
      ? extractPowerPressLink(html, url)
      : '';
    const transcriptLink = category === 'Podcast'
      ? extractTranscriptLink(postContent, url)
      : '';
    const sponsors = category === 'Podcast'
      ? extractSponsors(postContent, url)
      : [];
    const postContentHtml = extractArticleContent(postContent, url);
    const taxonomies = await fetchWordPressTaxonomies(html, url);
    const fallbackPublishedDate = extractHtmlPublishedDate(html);
    const publishedDate = taxonomies.publishedDate || fallbackPublishedDate.date;
    const publishedDateGmt = taxonomies.publishedDateGmt || fallbackPublishedDate.dateGmt;
    const date = formatPublishedDateForDisplay(publishedDate) || extractDateValue(meta);

    return {
      url,
      ok: true,
      count: date ? 1 : 0,
      title,
      featuredImage,
      date,
      category,
      powerPressLink,
      transcriptLink,
      sponsors,
      postContent: postContentHtml,
      articleContent: category === 'Article' ? postContentHtml : '',
      tags: taxonomies.tags,
      categories: taxonomies.categories,
      publishedDate,
      publishedDateGmt,
      meta
    };
  } catch (error) {
    return {
      url,
      ok: false,
      count: 0,
      title: '',
      featuredImage: null,
      date: '',
      category: '',
      powerPressLink: '',
      transcriptLink: '',
      sponsors: [],
      postContent: '',
      articleContent: '',
      tags: [],
      categories: [],
      publishedDate: '',
      publishedDateGmt: '',
      meta: [],
      error: error.message || 'Could not fetch the page.'
    };
  }
}

export function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];

  return [...new Set(
    links
      .map((link) => String(link || '').trim())
      .filter(Boolean)
      .filter((link) => {
        try {
          const url = new URL(link);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      })
  )];
}

function fetchHtml(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      const status = response.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();

        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects.'));
          return;
        }

        const nextUrl = new URL(response.headers.location, url).toString();
        resolve(fetchHtml(nextUrl, redirectsLeft - 1));
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        response.resume();
        reject(new Error('The URL did not return HTML.'));
        return;
      }

      let received = 0;
      const chunks = [];

      response.on('data', (chunk) => {
        received += chunk.length;

        if (received > MAX_BYTES) {
          request.destroy(new Error('The page is too large to fetch.'));
          return;
        }

        chunks.push(chunk);
      });

      response.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Fetch timeout exceeded.'));
    });

    request.on('error', reject);
  });
}

async function fetchWordPressTaxonomies(html, pageUrl) {
  try {
    const restRoot = getWordPressRestRoot(html, pageUrl);
    const slug = getSlugFromUrl(pageUrl);
    if (!restRoot) return { tags: [], categories: [], publishedDate: '', publishedDateGmt: '' };

    const post = await fetchWordPressPost(restRoot, slug, html, pageUrl);
    const tagIds = normalizeTermIds(post?.tags);
    const categoryIds = normalizeTermIds(post?.categories);

    const [tags, categories] = await Promise.all([
      fetchWordPressTerms(restRoot, 'tags', tagIds).catch(() => []),
      fetchWordPressTerms(restRoot, 'categories', categoryIds).catch(() => [])
    ]);

    return {
      tags: uniqueTerms(tags.length ? tags : extractHtmlTagTerms(html, pageUrl)),
      categories: uniqueTerms(categories.length ? categories : extractHtmlCategoryTerms(html, pageUrl)),
      publishedDate: normalizeWordPressRestDate(post?.date),
      publishedDateGmt: normalizeWordPressRestDate(post?.date_gmt)
    };
  } catch {
    return {
      tags: uniqueTerms(extractHtmlTagTerms(html, pageUrl)),
      categories: uniqueTerms(extractHtmlCategoryTerms(html, pageUrl)),
      publishedDate: '',
      publishedDateGmt: ''
    };
  }
}

function normalizeTermIds(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((id) => Number(id))
    .filter(Number.isFinite);
}

function normalizeWordPressRestDate(value) {
  return String(value || '')
    .trim()
    .replace('T', ' ')
    .replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '');
}

function extractHtmlPublishedDate(html) {
  const metaPattern = /<meta\b[^>]*(?:property|name)\s*=\s*(["'])(?:article:published_time|datePublished|pubdate)\1[^>]*>/gi;
  let match;

  while ((match = metaPattern.exec(html)) !== null) {
    const content = extractAttribute(match[0], 'content');
    const date = formatIsoDateForWordPress(content);
    if (date.date) return date;
  }

  const schemaDateMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (schemaDateMatch) {
    return formatIsoDateForWordPress(decodeHtmlEntities(schemaDateMatch[1]));
  }

  return { date: '', dateGmt: '' };
}

function formatIsoDateForWordPress(value) {
  const timestamp = Date.parse(String(value || '').trim());
  if (!Number.isFinite(timestamp)) return { date: '', dateGmt: '' };

  const date = new Date(timestamp);
  const wordpressDate = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
  const wordpressTime = [
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0')
  ].join(':');

  return {
    date: `${wordpressDate} ${wordpressTime}`,
    dateGmt: `${wordpressDate} ${wordpressTime}`
  };
}

function formatPublishedDateForDisplay(value) {
  const match = String(value || '').match(/\b(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\b/);
  if (!match) return '';

  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];
  const month = monthNames[Number(match[2]) - 1];
  if (!month) return value;

  return `${month} ${Number(match[3])} ${match[1]}, ${match[4]}`;
}

function extractHtmlTagTerms(html, pageUrl) {
  return extractHtmlTermsByRel(html, pageUrl, /\btag\b/i)
    .filter((term) => !/\bcategory\b/i.test(term.rel || ''))
    .map(({ rel, ...term }) => term);
}

function extractHtmlCategoryTerms(html, pageUrl) {
  return extractHtmlTermsByRel(html, pageUrl, /\bcategory\b/i)
    .map(({ rel, ...term }) => term);
}

function extractHtmlTermsByRel(html, pageUrl, relPattern) {
  const terms = [];
  const linkPattern = /<a\b[^>]*\brel\s*=\s*(["'])(.*?)\1[^>]*>[\s\S]*?<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const anchorHtml = match[0];
    const rel = match[2] || '';
    if (!relPattern.test(rel)) continue;

    const name = cleanText(anchorHtml);
    if (!name) continue;

    terms.push({
      id: undefined,
      name,
      slug: getSlugFromUrl(extractAttribute(anchorHtml, 'href') || ''),
      link: resolveUrl(extractAttribute(anchorHtml, 'href') || '', pageUrl),
      rel
    });
  }

  return terms;
}

export function getWordPressRestRoot(html, pageUrl) {
  const linkPattern = /<link\b[^>]*rel\s*=\s*(["'])https:\/\/api\.w\.org\/\1[^>]*>/i;
  const linkMatch = html.match(linkPattern);

  if (linkMatch) {
    const tag = linkMatch[0];
    const href = extractAttribute(tag, 'href');
    if (href) return ensureTrailingSlash(resolveUrl(href, pageUrl));
  }

  try {
    return new URL('/wp-json/', pageUrl).toString();
  } catch {
    return '';
  }
}

export function getSlugFromUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts.at(-1) || '');
  } catch {
    return '';
  }
}

async function fetchWordPressPost(restRoot, slug, html, pageUrl) {
  const directPostUrls = extractWordPressPostRestUrls(html, pageUrl);
  const postFields = 'id,slug,tags,categories,date,date_gmt';

  for (const url of directPostUrls) {
    try {
      const post = await fetchJson(addFieldsToRestUrl(url, postFields));
      if (post && !Array.isArray(post)) return post;
    } catch {
      // Try the next discovered REST URL.
    }
  }

  for (const postId of extractWordPressPostIds(html)) {
    const url = `${restRoot}wp/v2/posts/${postId}?_fields=${postFields}`;

    try {
      const post = await fetchJson(url);
      if (post && !Array.isArray(post)) return post;
    } catch {
      // Try the next discovered post ID.
    }
  }

  if (slug) {
    const standardPostUrl = `${restRoot}wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=${postFields}`;

    try {
      const posts = await fetchJson(standardPostUrl);
      if (Array.isArray(posts) && posts[0]) return posts[0];
    } catch {
      // Try fallback REST URLs below.
    }
  }

  return null;
}

export function extractWordPressPostIds(html) {
  const ids = new Set();
  const patterns = [
    /\bpostid-(\d+)\b/gi,
    /\bid\s*=\s*(["'])post-(\d+)\1/gi,
    /\bclass\s*=\s*(["'])(?:(?!\1).)*\bpost-(\d+)\b(?:(?!\1).)*\1/gi,
    /[?&]p=(\d+)\b/gi
  ];

  patterns.forEach((pattern) => {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      const id = Number(match[2] || match[1]);
      if (Number.isFinite(id)) ids.add(id);
    }
  });

  return [...ids];
}

export function extractWordPressPostRestUrls(html, pageUrl) {
  const urls = new Set();
  const linkPattern = /<link\b[^>]*>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const tag = match[0];
    const href = extractAttribute(tag, 'href');
    if (!href || !/\/wp-json\/wp\/v2\/[^"'<>\s]+\/\d+/i.test(href)) continue;
    urls.add(resolveUrl(href, pageUrl));
  }

  const inlinePattern = /https?:\\?\/\\?\/[^"'<>\\\s]+\/wp-json\/wp\/v2\/[^"'<>\\\s]+\/\d+/gi;
  let inlineMatch;

  while ((inlineMatch = inlinePattern.exec(html)) !== null) {
    urls.add(inlineMatch[0].replace(/\\\//g, '/'));
  }

  return [...urls];
}

function addFieldsToRestUrl(url, fields) {
  try {
    const restUrl = new URL(url);
    if (!restUrl.searchParams.has('_fields')) {
      restUrl.searchParams.set('_fields', fields);
    }
    return restUrl.toString();
  } catch {
    return url;
  }
}

async function fetchWordPressTerms(restRoot, taxonomyEndpoint, termIds) {
  const uniqueIds = [...new Set(termIds)];
  if (!uniqueIds.length) return [];

  const url = new URL(`wp/v2/${taxonomyEndpoint}`, restRoot);
  url.searchParams.set('include', uniqueIds.join(','));
  url.searchParams.set('per_page', '100');
  url.searchParams.set('_fields', 'id,name,slug,link');

  const terms = await fetchJson(url.toString());

  if (!Array.isArray(terms)) return [];

  return terms
    .map(normalizeWordPressTerm)
    .filter(Boolean);
}

function normalizeWordPressTerm(term) {
  const name = decodeHtmlEntities(String(term?.name || '')).trim();
  if (!name) return null;

  return {
    id: term.id,
    name,
    slug: String(term.slug || '').trim(),
    link: String(term.link || '').trim()
  };
}

function uniqueTerms(terms) {
  const seen = new Set();
  const unique = [];

  terms.forEach((term) => {
    const key = term.id || term.slug || term.name;
    if (!key || seen.has(key)) return;

    seen.add(key);
    unique.push(term);
  });

  return unique;
}

function fetchJson(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      const status = response.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();

        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects.'));
          return;
        }

        const nextUrl = new URL(response.headers.location, url).toString();
        resolve(fetchJson(nextUrl, redirectsLeft - 1));
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      let received = 0;
      const chunks = [];

      response.on('data', (chunk) => {
        received += chunk.length;

        if (received > MAX_BYTES) {
          request.destroy(new Error('The JSON response is too large to fetch.'));
          return;
        }

        chunks.push(chunk);
      });

      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Fetch timeout exceeded.'));
    });

    request.on('error', reject);
  });
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

export function extractArticleMeta(html) {
  return extractTextByClass(html, 'article__meta');
}

export function extractPostTitle(html) {
  return extractFirstTextByClass(html, 'post__title');
}

export function extractFeaturedImage(html, baseUrl = '') {
  const featuredImageHtml = extractFirstHtmlByClass(html, 'post__featured-image');
  if (!featuredImageHtml) return null;

  const imageTag = featuredImageHtml.match(/<img\b[^>]*>/i)?.[0] || '';
  if (!imageTag) return null;

  const src = sanitizeUrlAttribute(
    extractAttribute(imageTag, 'src')
      || extractAttribute(imageTag, 'data-src')
      || extractFirstSrcsetUrl(extractAttribute(imageTag, 'srcset'))
      || extractFirstSrcsetUrl(extractAttribute(imageTag, 'data-srcset')),
    baseUrl
  );

  if (!src) return null;

  return {
    src,
    alt: cleanText(extractAttribute(imageTag, 'alt') || '')
  };
}

export function extractPowerPressLink(html, baseUrl = '') {
  const elements = extractHtmlByClass(html, 'powerpress_link_pinw');

  for (const elementHtml of elements) {
    const directHref = extractAttribute(elementHtml.match(/^<a\b[^>]*>/i)?.[0] || '', 'href');
    const nestedLink = elementHtml.match(/<a\b[^>]*>/i)?.[0] || '';
    const href = directHref || extractAttribute(nestedLink, 'href');
    const resolved = sanitizeUrlAttribute(href, baseUrl);

    if (resolved) return resolved;
  }

  return '';
}

export function extractPostContent(html) {
  return extractFirstHtmlByClass(html, 'post__content');
}

export function extractArticleContent(postContentHtml, baseUrl = '') {
  if (!postContentHtml) return '';

  const authorHeaderIndex = findElementIndexByClass(postContentHtml, 'author-header');
  const contentHtml = authorHeaderIndex >= 0
    ? postContentHtml.slice(0, authorHeaderIndex)
    : postContentHtml;

  return sanitizeArticleHtml(contentHtml, baseUrl);
}

export function extractTranscriptLink(postContentHtml, baseUrl) {
  if (!postContentHtml) return '';

  const linkPattern = /<a\b([^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(postContentHtml)) !== null) {
    const href = decodeHtmlEntities(match[3] || '').trim();
    const label = cleanText(match[4] || '');

    if (!href || !/\btranscript\b/i.test(label)) continue;

    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href;
    }
  }

  return '';
}

function findElementIndexByClass(html, className) {
  const escapedClassName = escapeRegExp(className);
  const pattern = new RegExp(`<[a-z][\\w:-]*[^>]*\\bclass\\s*=\\s*(["'])(?:(?!\\1).)*\\b${escapedClassName}\\b(?:(?!\\1).)*\\1[^>]*>`, 'i');
  const match = html.match(pattern);
  return match?.index ?? -1;
}

export function extractSponsors(postContentHtml, baseUrl) {
  const sponsorsSection = extractSectionAfterHeading(postContentHtml, /^sponsors?$/i);
  if (!sponsorsSection) return [];

  const imagePattern = /<img\b[^>]*>/gi;
  const imageMatches = [...sponsorsSection.matchAll(imagePattern)];
  if (!imageMatches.length) return [];

  return imageMatches
    .map((match, index) => {
      const imageTag = match[0];
      const nextImage = imageMatches[index + 1];
      const descriptionHtml = sponsorsSection.slice(
        match.index + imageTag.length,
        nextImage ? nextImage.index : sponsorsSection.length
      );
      const imageUrl = resolveUrl(
        extractAttribute(imageTag, 'src')
          || extractAttribute(imageTag, 'data-src')
          || extractFirstSrcsetUrl(extractAttribute(imageTag, 'srcset'))
          || extractFirstSrcsetUrl(extractAttribute(imageTag, 'data-srcset')),
        baseUrl
      );
      const description = sanitizeArticleHtml(descriptionHtml, baseUrl, { allowImages: false });
      const descriptionText = cleanText(description);
      const links = extractLinks(descriptionHtml, baseUrl);
      const alt = cleanText(extractAttribute(imageTag, 'alt') || '');

      return {
        image: imageUrl,
        alt,
        description,
        descriptionText,
        links
      };
    })
    .filter((sponsor) => sponsor.image && (sponsor.descriptionText || sponsor.links.length));
}

function extractSectionAfterHeading(html, headingTextPattern) {
  if (!html) return '';

  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;

  while ((match = headingPattern.exec(html)) !== null) {
    const headingText = cleanText(match[2] || '');
    if (!headingTextPattern.test(headingText)) continue;

    const headingLevel = Number(match[1]);
    const start = headingPattern.lastIndex;
    const rest = html.slice(start);
    const nextHeading = findNextHeadingAtOrAboveLevel(rest, headingLevel);
    return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  }

  return '';
}

function findNextHeadingAtOrAboveLevel(html, level) {
  const headingPattern = /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi;
  let match;

  while ((match = headingPattern.exec(html)) !== null) {
    if (Number(match[1]) <= level) {
      return match.index;
    }
  }

  return -1;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const linkPattern = /<a\b([^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const href = decodeHtmlEntities(match[3] || '').trim();
    if (!href) continue;

    links.push({
      url: resolveUrl(href, baseUrl),
      text: cleanText(match[4] || '') || href
    });
  }

  return links;
}

function extractAttribute(tagHtml, attributeName) {
  const pattern = new RegExp(`\\b${escapeRegExp(attributeName)}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = tagHtml.match(pattern);
  return match ? decodeHtmlEntities(match[2]).trim() : '';
}

function extractFirstSrcsetUrl(srcset) {
  if (!srcset) return '';
  return srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
}

function resolveUrl(value, baseUrl) {
  if (!value) return '';

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function extractFirstTextByClass(html, className) {
  return extractTextByClass(html, className)[0] || '';
}

function extractTextByClass(html, className) {
  return extractHtmlByClass(html, className).map(cleanText).filter(Boolean);
}

function extractFirstHtmlByClass(html, className) {
  return extractHtmlByClass(html, className)[0] || '';
}

function extractHtmlByClass(html, className) {
  const matches = [];
  const escapedClassName = escapeRegExp(className);
  const tagPattern = new RegExp(`<([a-z][\\w:-]*)([^>]*\\bclass\\s*=\\s*(["'])(?:(?!\\3).)*\\b${escapedClassName}\\b(?:(?!\\3).)*\\3[^>]*)>`, 'gi');
  let tagMatch;

  while ((tagMatch = tagPattern.exec(html)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    const startIndex = tagMatch.index;
    const startTagEnd = tagPattern.lastIndex;
    const closeIndex = findClosingTag(html, tagName, startTagEnd);
    const rawElement = closeIndex >= 0
      ? html.slice(startIndex, closeIndex)
      : html.slice(startIndex, startTagEnd);
    if (rawElement) {
      matches.push(rawElement);
    }
  }

  return matches;
}

function extractDateValue(meta) {
  const value = meta.find(Boolean) || '';
  if (!value) return '';

  const datePatterns = [
    /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/,
    /\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
    /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/i
  ];

  for (const pattern of datePatterns) {
    const match = value.match(pattern);
    if (match) return match[0];
  }

  return value;
}

function detectCategory({ url, title, meta }) {
  const haystack = [url, title, ...meta].join(' ').toLowerCase();

  if (/\b(podcast|pocast)\b/.test(haystack) || haystack.includes('/podcast') || haystack.includes('/pocast')) {
    return 'Podcast';
  }

  return 'Article';
}

function findClosingTag(html, tagName, fromIndex) {
  const tagRegex = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
  tagRegex.lastIndex = fromIndex;

  let depth = 1;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const token = match[0];
    const isClosing = token.startsWith('</');
    const isSelfClosing = token.endsWith('/>') || isVoidElement(tagName);

    if (isClosing) depth -= 1;
    else if (!isSelfClosing) depth += 1;

    if (depth === 0) {
      return tagRegex.lastIndex;
    }
  }

  return -1;
}

function cleanText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .trim()
  );
}

function sanitizeArticleHtml(html, baseUrl, options = {}) {
  const allowImages = options.allowImages !== false;
  const allowedTags = new Set([
    'a',
    'blockquote',
    'br',
    'em',
    'h2',
    'h3',
    'h4',
    'li',
    'ol',
    'p',
    'strong',
    'ul'
  ]);

  if (allowImages) {
    allowedTags.add('img');
  }
  const voidTags = new Set(['br', 'img']);

  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|svg|canvas|form|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|svg|canvas|form|noscript)\b[^>]*\/?>/gi, '');

  const sanitized = stripped.replace(/<\/?([a-z][\w:-]*)([^>]*)>/gi, (tag, rawTagName) => {
    const tagName = rawTagName.toLowerCase();
    const isClosing = tag.startsWith('</');

    if (!allowedTags.has(tagName)) return '';
    if (isClosing) return voidTags.has(tagName) ? '' : `</${tagName}>`;

    if (tagName === 'br') return '<br>';

    if (tagName === 'a') {
      const href = sanitizeUrlAttribute(extractAttribute(tag, 'href'), baseUrl);
      return href ? `<a href="${escapeHtmlAttribute(href)}">` : '<a>';
    }

    if (tagName === 'img') {
      const src = sanitizeUrlAttribute(
        extractAttribute(tag, 'src')
          || extractAttribute(tag, 'data-src')
          || extractFirstSrcsetUrl(extractAttribute(tag, 'srcset'))
          || extractFirstSrcsetUrl(extractAttribute(tag, 'data-srcset')),
        baseUrl
      );
      if (!src) return '';

      const alt = cleanText(extractAttribute(tag, 'alt') || '');
      return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}">`;
    }

    return `<${tagName}>`;
  });

  return removeEmptyHtmlTags(sanitized)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeUrlAttribute(value, baseUrl) {
  if (!value) return '';

  const trimmed = decodeHtmlEntities(value).trim();
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return '';

  return resolveUrl(trimmed, baseUrl);
}

function removeEmptyHtmlTags(html) {
  const emptyContent = String.raw`(?:\s|&nbsp;|&#160;|&#xA0;|&#xa0;|<br>\s*)*`;
  let previous = '';
  let current = html
    .replace(new RegExp(`<((?:p|li|h2|h3|h4|blockquote))>${emptyContent}<\\/\\1>`, 'gi'), '')
    .replace(/<a(?:\s+href="[^"]*")?>\s*<\/a>/gi, '')
    .replace(new RegExp(`<((?:ul|ol))>${emptyContent}<\\/\\1>`, 'gi'), '');

  while (current !== previous) {
    previous = current;
    current = current
      .replace(new RegExp(`<((?:p|li|h2|h3|h4|blockquote))>${emptyContent}<\\/\\1>`, 'gi'), '')
      .replace(new RegExp(`<((?:ul|ol))>${emptyContent}<\\/\\1>`, 'gi'), '');
  }

  return current;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeHtmlEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }

    return named[code.toLowerCase()] || entity;
  });
}

function isVoidElement(tagName) {
  return ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tagName);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream'
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error('Payload jest za duzy.'));
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
