const form = document.querySelector('#scrape-form');
const textarea = document.querySelector('#links');
const statusEl = document.querySelector('#status');
const resultsList = document.querySelector('#results-list');
const summaryEl = document.querySelector('#summary');
const submitButton = document.querySelector('#submit-button');
const clearButton = document.querySelector('#clear-button');
const csvButton = document.querySelector('#csv-button');
const wordpressExportButton = document.querySelector('#wordpress-export-button');
const postTypeFilter = document.querySelector('#post-type-filter');
const sponsorFilter = document.querySelector('#sponsor-filter');
const sponsorView = document.querySelector('#sponsor-view');

let lastResults = [];

renderEmpty();
updateSponsorViewAvailability();

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const links = textarea.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!links.length) {
    setStatus('Paste at least one link.', true);
    return;
  }

  setLoading(true);
  setStatus(`Fetching ${links.length} ${links.length === 1 ? 'URL' : 'URLs'}...`);

  try {
    const response = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Scraping failed.');
    }

    lastResults = payload.results || [];
    renderResults(getVisibleResults());
    csvButton.disabled = lastResults.length === 0;
    wordpressExportButton.disabled = lastResults.length === 0;
    setStatus('Done.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setLoading(false);
  }
});

clearButton.addEventListener('click', () => {
  textarea.value = '';
  lastResults = [];
  postTypeFilter.value = 'all';
  sponsorFilter.value = 'all';
  sponsorView.value = 'posts';
  updateSponsorViewAvailability();
  csvButton.disabled = true;
  wordpressExportButton.disabled = true;
  setStatus('One line = one link. Limit: 100 URLs.');
  renderEmpty();
});

postTypeFilter.addEventListener('change', () => {
  renderResults(getVisibleResults());
});

sponsorFilter.addEventListener('change', () => {
  updateSponsorViewAvailability();
  renderResults(getVisibleResults());
});

sponsorView.addEventListener('change', () => {
  renderResults(getVisibleResults());
});

csvButton.addEventListener('click', () => {
  if (!lastResults.length) return;

  const visibleResults = getVisibleResults();
  const rows = isSponsorOnlyView()
    ? createSponsorCsvRows(visibleResults)
    : createCsvRows(visibleResults);
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sedscraper-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

wordpressExportButton.addEventListener('click', () => {
  if (!lastResults.length) return;

  const wxr = createWordPressWxr(getFilteredResults());
  const blob = new Blob([wxr], { type: 'application/rss+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `wordpress-import-${new Date().toISOString().slice(0, 10)}.xml`;
  link.click();
  URL.revokeObjectURL(url);
});

export function createCsvRows(results) {
  const rows = [['url', 'status', 'post_title', 'date', 'category', 'tags', 'scraped_categories', 'post_content', 'powerpress_link', 'transcript_link', 'sponsor_images', 'sponsor_descriptions', 'sponsor_links']];

  results.forEach((result) => {
    if (!result.ok) {
      rows.push([result.url, `error: ${result.error || ''}`, '', '', '', '', '', '', '', '', '', '', '']);
      return;
    }

    const sponsors = result.sponsors || [];

    rows.push([
      result.url,
      result.date ? 'ok' : 'missing .article__meta',
      result.title || '',
      result.date || '',
      result.category || '',
      formatTerms(result.tags || []),
      formatTerms(result.categories || []),
      result.postContent || result.articleContent || '',
      result.powerPressLink || '',
      result.transcriptLink || '',
      sponsors.map((sponsor) => sponsor.image).filter(Boolean).join(' | '),
      sponsors.map((sponsor) => sponsor.descriptionText || htmlToText(sponsor.description || '')).filter(Boolean).join(' | '),
      sponsors.map((sponsor) => formatSponsorLinks(sponsor.links || [])).filter(Boolean).join(' | ')
    ]);
  });

  return rows;
}

export function createWordPressWxr(results) {
  const now = new Date().toUTCString();
  const posts = results.filter((result) => result.ok);
  const declaredTags = createWordPressTagDeclarations(posts);
  const declaredCategories = createWordPressCategoryDeclarations(posts);
  const attachmentStartId = posts.length + 1;
  const items = posts
    .map((result, index) => {
      const title = result.title || '';
      const slug = getPostSlug(result.url);
      const content = result.postContent || result.articleContent || '';
      const postDate = formatWordPressDate(result.publishedDate || result.date, result.url, result.publishedDateGmt);
      const pubDate = postDate.rss || now;
      const tags = createWordPressTagEntries(result.tags || []);
      const categories = createWordPressCategoryEntries(result.categories || []);
      const postId = index + 1;
      const attachmentId = result.featuredImage?.src ? attachmentStartId + index : '';
      const thumbnailMeta = attachmentId
        ? createWordPressPostMeta('_thumbnail_id', String(attachmentId))
        : '';

      return [
        '    <item>',
        `      <title>${escapeXml(title)}</title>`,
        `      <link>${escapeXml(result.url || '')}</link>`,
        `      <pubDate>${escapeXml(pubDate)}</pubDate>`,
        `      <dc:creator><![CDATA[admin]]></dc:creator>`,
        `      <guid isPermaLink="false">${escapeXml(`sedscraper-post-${postId}`)}</guid>`,
        `      <description></description>`,
        categories,
        tags,
        `      <content:encoded><![CDATA[${escapeCdata(content)}]]></content:encoded>`,
        `      <excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
        `      <wp:post_id>${postId}</wp:post_id>`,
        `      <wp:post_date><![CDATA[${postDate.date}]]></wp:post_date>`,
        `      <wp:post_date_gmt><![CDATA[${postDate.dateGmt}]]></wp:post_date_gmt>`,
        `      <wp:post_modified><![CDATA[${postDate.date}]]></wp:post_modified>`,
        `      <wp:post_modified_gmt><![CDATA[${postDate.dateGmt}]]></wp:post_modified_gmt>`,
        `      <wp:comment_status><![CDATA[closed]]></wp:comment_status>`,
        `      <wp:ping_status><![CDATA[closed]]></wp:ping_status>`,
        `      <wp:post_name><![CDATA[${escapeCdata(slug)}]]></wp:post_name>`,
        `      <wp:status><![CDATA[publish]]></wp:status>`,
        `      <wp:post_parent>0</wp:post_parent>`,
        `      <wp:menu_order>0</wp:menu_order>`,
        `      <wp:post_type><![CDATA[post]]></wp:post_type>`,
        `      <wp:post_password><![CDATA[]]></wp:post_password>`,
        `      <wp:is_sticky>0</wp:is_sticky>`,
        thumbnailMeta,
        '    </item>'
      ].filter(Boolean).join('\n');
    })
    .join('\n');
  const attachments = posts
    .map((result, index) => createWordPressAttachmentItem(result, attachmentStartId + index, index + 1, now))
    .filter(Boolean)
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<rss version="2.0"',
    '  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"',
    '  xmlns:content="http://purl.org/rss/1.0/modules/content/"',
    '  xmlns:wfw="http://wellformedweb.org/CommentAPI/"',
    '  xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '  xmlns:wp="http://wordpress.org/export/1.2/"',
    '>',
    '  <channel>',
    '    <title>SEDscraper Export</title>',
    '    <link>https://softwareengineeringdaily.com/</link>',
    '    <description>Generated by SEDscraper</description>',
    `    <pubDate>${escapeXml(now)}</pubDate>`,
    '    <language>en-US</language>',
    '    <wp:wxr_version>1.2</wp:wxr_version>',
    '    <wp:base_site_url>https://softwareengineeringdaily.com</wp:base_site_url>',
    '    <wp:base_blog_url>https://softwareengineeringdaily.com</wp:base_blog_url>',
    '    <wp:author>',
    '      <wp:author_id>1</wp:author_id>',
    '      <wp:author_login><![CDATA[admin]]></wp:author_login>',
    '      <wp:author_email><![CDATA[]]></wp:author_email>',
    '      <wp:author_display_name><![CDATA[admin]]></wp:author_display_name>',
    '      <wp:author_first_name><![CDATA[]]></wp:author_first_name>',
    '      <wp:author_last_name><![CDATA[]]></wp:author_last_name>',
    '    </wp:author>',
    declaredCategories,
    declaredTags,
    items,
    attachments,
    '  </channel>',
    '</rss>'
  ].filter(Boolean).join('\n');
}

export function createSponsorCsvRows(results) {
  const rows = [['image', 'description', 'link']];

  getSponsorsFromResults(results).forEach((sponsor) => {
    rows.push([
      sponsor.image || '',
      sponsor.descriptionText || htmlToText(sponsor.description || ''),
      formatSponsorLinks(sponsor.links || [])
    ]);
  });

  return rows;
}

function renderResults(results) {
  resultsList.replaceChildren();

  if (!results.length) {
    renderEmpty(getEmptyMessage());
    return;
  }

  if (isSponsorOnlyView()) {
    renderSponsorOnlyResults(results);
    return;
  }

  const okCount = results.filter((result) => result.ok).length;
  const articleCount = results.filter((result) => result.category === 'Article').length;
  const podcastCount = results.filter((result) => result.category === 'Podcast').length;
  const dateCount = results.filter((result) => result.date).length;
  const transcriptCount = results.filter((result) => result.transcriptLink).length;
  const sponsorCount = results.reduce((sum, result) => sum + (result.sponsors?.length || 0), 0);
  summaryEl.textContent = `${okCount}/${results.length} fetched, ${articleCount} articles, ${podcastCount} podcasts, ${dateCount} with date, ${transcriptCount} transcript, ${sponsorCount} sponsors`;

  results.forEach((result) => {
    const card = document.createElement('article');
    card.className = 'result-card';

    const top = document.createElement('div');
    top.className = 'result-top';

    const url = document.createElement('a');
    url.className = 'result-url';
    url.href = result.url;
    url.target = '_blank';
    url.rel = 'noreferrer';
    url.textContent = result.url;

    const badge = document.createElement('span');
    badge.className = `badge${result.ok ? '' : ' error'}`;
    badge.textContent = result.ok ? (result.category || 'Article') : 'error';

    top.append(url, badge);
    card.append(top);

    if (!result.ok) {
      const error = document.createElement('p');
      error.className = 'error-text';
      error.textContent = result.error || 'Could not fetch data.';
      card.append(error);
    } else {
      const postTitle = result.title || 'Missing .post__title';
      const title = document.createElement('h3');
      title.className = 'post-title';

      const titleText = document.createElement('span');
      titleText.textContent = postTitle;
      title.append(titleText, createCopyButton('Post title', postTitle));

      card.append(title);

      if (result.featuredImage?.src) {
        card.append(createFeaturedImage(result.featuredImage));
      }

      const details = document.createElement('dl');
      details.className = 'result-details';

      details.append(
        createDetail('Date', result.date || 'Missing .article__meta'),
        createDetail('Post slug', getPostSlug(result.url)),
        createDetail('Category', result.category || 'Article')
      );

      details.append(createDetail('Categories', formatTerms(result.categories || []) || 'No categories', 'full'));
      details.append(createDetail('Tags', formatTerms(result.tags || []) || 'No tags', 'full'));

      if (result.category === 'Podcast' && result.powerPressLink) {
        details.append(createLinkDetail('PowerPress link', result.powerPressLink));
      }

      if (result.category === 'Podcast' && result.transcriptLink) {
        details.append(createLinkDetail('Transcript link', result.transcriptLink));
      }

      const cleanedPostContent = result.postContent || result.articleContent || '';

      if (cleanedPostContent) {
        details.append(createHtmlDetail('Post content', cleanedPostContent, 'full article-content-field'));
      }

      card.append(details);

      if (result.category === 'Podcast' && result.sponsors?.length) {
        card.append(createSponsors(result.sponsors));
      }
    }

    resultsList.append(card);
  });
}

function createFeaturedImage(featuredImage) {
  const figure = document.createElement('figure');
  figure.className = 'featured-image';

  const link = document.createElement('a');
  link.href = featuredImage.src;
  link.target = '_blank';
  link.rel = 'noreferrer';

  const image = document.createElement('img');
  image.src = featuredImage.src;
  image.alt = featuredImage.alt || 'Featured image';
  image.loading = 'lazy';

  link.append(image);
  figure.append(link);
  return figure;
}

function renderSponsorOnlyResults(results) {
  const sponsors = getSponsorsFromResults(results);

  if (!sponsors.length) {
    renderEmpty('No sponsors for the current filters.');
    return;
  }

  summaryEl.textContent = `${sponsors.length} sponsors`;

  sponsors.forEach((sponsor) => {
    const card = document.createElement('article');
    card.className = 'result-card sponsor-only-card';
    card.append(createSponsorItem(sponsor));
    resultsList.append(card);
  });
}

function getVisibleResults() {
  return getFilteredResults();
}

function getPostSlug(url) {
  try {
    const parsedUrl = new URL(url);
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts.at(-1) || '');
  } catch {
    return '';
  }
}

function getFilteredResults() {
  const selectedType = postTypeFilter.value;
  const selectedSponsorState = sponsorFilter.value;

  return lastResults.filter((result) => {
    const typeMatches = selectedType === 'all' || result.category === selectedType;
    const hasSponsors = (result.sponsors?.length || 0) > 0;
    const sponsorMatches = selectedSponsorState === 'all'
      || (selectedSponsorState === 'with' && hasSponsors)
      || (selectedSponsorState === 'without' && !hasSponsors);

    return typeMatches && sponsorMatches;
  });
}

function isSponsorOnlyView() {
  return sponsorFilter.value === 'with' && sponsorView.value === 'sponsors';
}

function updateSponsorViewAvailability() {
  const canShowSponsorsOnly = sponsorFilter.value === 'with';
  sponsorView.disabled = !canShowSponsorsOnly;

  if (!canShowSponsorsOnly) {
    sponsorView.value = 'posts';
  }
}

function getSponsorsFromResults(results) {
  const seen = new Set();
  const uniqueSponsors = [];

  results.flatMap((result) => result.sponsors || []).forEach((sponsor) => {
    const key = sponsor.image
      ? `image:${sponsor.image}`
      : [
          'content',
          sponsor.descriptionText || htmlToText(sponsor.description || ''),
          formatSponsorLinks(sponsor.links || [])
        ].join('\u001f');

    if (seen.has(key)) return;

    seen.add(key);
    uniqueSponsors.push(sponsor);
  });

  return uniqueSponsors;
}

function createSponsors(sponsors) {
  const section = document.createElement('section');
  section.className = 'sponsors';

  const heading = document.createElement('h4');
  heading.textContent = 'Sponsors';
  section.append(heading);

  const list = document.createElement('div');
  list.className = 'sponsors-list';

  sponsors.forEach((sponsor) => {
    list.append(createSponsorItem(sponsor));
  });

  section.append(list);
  return section;
}

function createSponsorItem(sponsor) {
  const item = document.createElement('article');
  item.className = 'sponsor-card';

  if (sponsor.image) {
    const image = document.createElement('img');
    image.src = sponsor.image;
    image.alt = sponsor.alt || 'Sponsor image';
    image.loading = 'lazy';
    item.append(image);
  }

  const body = document.createElement('div');
  body.className = 'sponsor-body';

  const sponsorActions = document.createElement('div');
  sponsorActions.className = 'sponsor-actions';
  sponsorActions.append(createCopyButton('Sponsor content', sponsor.description || sponsor.descriptionText || ''));
  body.append(sponsorActions);

  const description = document.createElement('div');
  description.className = 'sponsor-description';
  description.innerHTML = sponsor.description || '<p>No sponsor description found.</p>';
  description.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noreferrer';
  });
  body.append(description);

  if (sponsor.links?.length) {
    const links = document.createElement('ul');
    links.className = 'sponsor-links';

    sponsor.links.forEach((sponsorLink) => {
      const linkItem = document.createElement('li');
      const link = document.createElement('a');
      link.href = sponsorLink.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = sponsorLink.text || sponsorLink.url;
      linkItem.append(link);
      links.append(linkItem);
    });

    body.append(links);
  }

  item.append(body);
  return item;
}

function createDetail(label, value, extraClass = '') {
  const wrapper = document.createElement('div');
  wrapper.className = ['result-field', extraClass].filter(Boolean).join(' ');

  const term = createFieldTerm(label, value);

  const description = document.createElement('dd');
  description.textContent = value;

  wrapper.append(term, description);
  return wrapper;
}

function createHtmlDetail(label, value, extraClass = '') {
  const wrapper = document.createElement('div');
  wrapper.className = ['result-field', extraClass].filter(Boolean).join(' ');

  const term = createFieldTerm(label, value);

  const description = document.createElement('dd');
  description.innerHTML = value;

  description.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noreferrer';
  });

  wrapper.append(term, description);
  return wrapper;
}

function createLinkDetail(label, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'result-field full';

  const term = createFieldTerm(label, value);

  const description = document.createElement('dd');
  const link = document.createElement('a');
  link.className = 'transcript-link';
  link.href = value;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = value;

  description.append(link);
  wrapper.append(term, description);
  return wrapper;
}

function createFieldTerm(label, copyValue) {
  const term = document.createElement('dt');

  const labelText = document.createElement('span');
  labelText.textContent = label;

  term.append(labelText, createCopyButton(label, copyValue));
  return term;
}

function createCopyButton(label, copyValue) {
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'copy-field-button';
  copyButton.textContent = 'Copy';
  copyButton.setAttribute('aria-label', `Copy ${label}`);
  copyButton.addEventListener('click', () => {
    copyFieldValue(copyValue, copyButton);
  });

  return copyButton;
}

async function copyFieldValue(value, button) {
  const text = String(value || '');
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }

    showCopyFeedback(button);
  } catch {
    fallbackCopyText(text);
    showCopyFeedback(button);
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function showCopyFeedback(button) {
  const originalText = button.textContent;
  button.textContent = 'Copied';
  button.disabled = true;

  window.setTimeout(() => {
    button.textContent = originalText;
    button.disabled = false;
  }, 1100);
}

function renderEmpty(message = 'Results will appear here after scraping.') {
  summaryEl.textContent = lastResults.length ? 'No matching results' : 'No data';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  resultsList.replaceChildren(empty);
}

function getEmptyMessage() {
  if (!lastResults.length) return 'Results will appear here after scraping.';
  const typeLabel = postTypeFilter.value === 'all' ? 'post' : postTypeFilter.value.toLowerCase();
  const sponsorLabel = sponsorFilter.value === 'with'
    ? ' with sponsors'
    : sponsorFilter.value === 'without'
      ? ' without sponsors'
      : '';
  return `No ${typeLabel} results${sponsorLabel} for the current scrape.`;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? 'Working...' : '↳ Scrape';
}

function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCdata(value) {
  return String(value || '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function createWordPressTagDeclarations(results) {
  const seen = new Set();
  const declarations = [];

  results.forEach((result) => {
    (result.tags || []).forEach((tag) => {
      const term = normalizeWordPressExportTerm(tag);
      if (!term.name || seen.has(term.slug)) return;

      seen.add(term.slug);
      declarations.push([
        '    <wp:tag>',
        `      <wp:term_id>${declarations.length + 1}</wp:term_id>`,
        `      <wp:tag_slug><![CDATA[${escapeCdata(term.slug)}]]></wp:tag_slug>`,
        `      <wp:tag_name><![CDATA[${escapeCdata(term.name)}]]></wp:tag_name>`,
        '    </wp:tag>'
      ].join('\n'));
    });
  });

  return declarations.join('\n');
}

function createWordPressCategoryDeclarations(results) {
  const seen = new Set();
  const declarations = [];

  results.forEach((result) => {
    (result.categories || []).forEach((category) => {
      const term = normalizeWordPressExportTerm(category);
      if (!term.name || seen.has(term.slug)) return;

      seen.add(term.slug);
      declarations.push([
        '    <wp:category>',
        `      <wp:term_id>${declarations.length + 1}</wp:term_id>`,
        `      <wp:category_nicename><![CDATA[${escapeCdata(term.slug)}]]></wp:category_nicename>`,
        `      <wp:cat_name><![CDATA[${escapeCdata(term.name)}]]></wp:cat_name>`,
        '    </wp:category>'
      ].join('\n'));
    });
  });

  return declarations.join('\n');
}

function createWordPressTagEntries(tags) {
  return tags
    .map((tag) => {
      const term = normalizeWordPressExportTerm(tag);
      if (!term.name) return '';

      return `      <category domain="post_tag" nicename="${escapeXml(term.slug)}"><![CDATA[${escapeCdata(term.name)}]]></category>`;
    })
    .filter(Boolean)
    .join('\n');
}

function createWordPressCategoryEntries(categories) {
  return categories
    .map((category) => {
      const term = normalizeWordPressExportTerm(category);
      if (!term.name) return '';

      return `      <category domain="category" nicename="${escapeXml(term.slug)}"><![CDATA[${escapeCdata(term.name)}]]></category>`;
    })
    .filter(Boolean)
    .join('\n');
}

function createWordPressAttachmentItem(result, attachmentId, postId, fallbackDate) {
  const imageUrl = result.featuredImage?.src || '';
  if (!imageUrl) return '';

  const postDate = formatWordPressDate(result.publishedDate || result.date, result.url, result.publishedDateGmt);
  const pubDate = postDate.rss || fallbackDate;
  const imageTitle = result.featuredImage?.alt || result.title || getImageFilename(imageUrl);
  const imageSlug = slugifyTerm(getImageFilename(imageUrl).replace(/\.[a-z0-9]+$/i, '') || imageTitle);

  return [
    '    <item>',
    `      <title>${escapeXml(imageTitle)}</title>`,
    `      <link>${escapeXml(imageUrl)}</link>`,
    `      <pubDate>${escapeXml(pubDate)}</pubDate>`,
    `      <dc:creator><![CDATA[admin]]></dc:creator>`,
    `      <guid isPermaLink="false">${escapeXml(imageUrl)}</guid>`,
    `      <description></description>`,
    `      <content:encoded><![CDATA[]]></content:encoded>`,
    `      <excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
    `      <wp:post_id>${attachmentId}</wp:post_id>`,
    `      <wp:post_date><![CDATA[${postDate.date}]]></wp:post_date>`,
    `      <wp:post_date_gmt><![CDATA[${postDate.dateGmt}]]></wp:post_date_gmt>`,
    `      <wp:post_modified><![CDATA[${postDate.date}]]></wp:post_modified>`,
    `      <wp:post_modified_gmt><![CDATA[${postDate.dateGmt}]]></wp:post_modified_gmt>`,
    `      <wp:comment_status><![CDATA[closed]]></wp:comment_status>`,
    `      <wp:ping_status><![CDATA[closed]]></wp:ping_status>`,
    `      <wp:post_name><![CDATA[${escapeCdata(imageSlug)}]]></wp:post_name>`,
    `      <wp:status><![CDATA[inherit]]></wp:status>`,
    `      <wp:post_parent>${postId}</wp:post_parent>`,
    `      <wp:menu_order>0</wp:menu_order>`,
    `      <wp:post_type><![CDATA[attachment]]></wp:post_type>`,
    `      <wp:post_password><![CDATA[]]></wp:post_password>`,
    `      <wp:is_sticky>0</wp:is_sticky>`,
    `      <wp:attachment_url>${escapeXml(imageUrl)}</wp:attachment_url>`,
    createWordPressPostMeta('_wp_attached_file', imageUrl),
    '    </item>'
  ].join('\n');
}

function createWordPressPostMeta(key, value) {
  return [
    '      <wp:postmeta>',
    `        <wp:meta_key><![CDATA[${escapeCdata(key)}]]></wp:meta_key>`,
    `        <wp:meta_value><![CDATA[${escapeCdata(value)}]]></wp:meta_value>`,
    '      </wp:postmeta>'
  ].join('\n');
}

function normalizeWordPressExportTerm(term) {
  const name = String(term?.name || term?.slug || term || '').trim();
  const slug = String(term?.slug || slugifyTerm(name)).trim();

  return { name, slug };
}

function getImageFilename(value) {
  try {
    const url = new URL(value);
    const filename = url.pathname.split('/').filter(Boolean).at(-1) || 'featured-image';
    return decodeURIComponent(filename);
  } catch {
    return 'featured-image';
  }
}

function formatWordPressDate(value, fallbackUrl = '', gmtValue = '') {
  const date = parseScrapedDate(value) || parseDateFromUrl(fallbackUrl);
  if (!date) return { date: '', dateGmt: '', rss: '' };
  const gmtDate = parseScrapedDate(gmtValue) || date;

  return {
    date: formatWordPressDateTime(date),
    dateGmt: formatWordPressDateTime(gmtDate),
    rss: gmtDate.toUTCString()
  };
}

function formatWordPressDateTime(date) {
  const day = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
  const time = [
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0')
  ].join(':');

  return `${day} ${time}`;
}

function parseScrapedDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const monthNames = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };
  const monthMatch = text.match(/\b([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/);

  if (monthMatch) {
    const month = monthNames[monthMatch[1].toLowerCase()];
    const day = Number(monthMatch[2]);
    const year = Number(monthMatch[3]);

    if (Number.isInteger(month) && Number.isFinite(day) && Number.isFinite(year)) {
      return new Date(Date.UTC(year, month, day));
    }
  }

  const numericMatch = text.match(/\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (numericMatch) {
    const timeMatch = text.match(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    return new Date(Date.UTC(
      Number(numericMatch[1]),
      Number(numericMatch[2]) - 1,
      Number(numericMatch[3]),
      timeMatch ? Number(timeMatch[1]) : 0,
      timeMatch ? Number(timeMatch[2]) : 0,
      timeMatch?.[3] ? Number(timeMatch[3]) : 0
    ));
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function parseDateFromUrl(value) {
  try {
    const { pathname } = new URL(value);
    const match = pathname.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
    if (!match) return null;

    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  } catch {
    return null;
  }
}

function slugifyTerm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatSponsorLinks(links) {
  return links.map((link) => `${link.text || link.url}: ${link.url}`).join(' | ');
}

function formatTerms(terms) {
  return terms.map((term) => term.name || term.slug || String(term)).filter(Boolean).join(', ');
}

function htmlToText(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.textContent.replace(/\s+/g, ' ').trim();
}
