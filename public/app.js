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
  const items = results
    .filter((result) => result.ok)
    .map((result, index) => {
      const title = result.title || '';
      const slug = getPostSlug(result.url);
      const content = result.postContent || result.articleContent || '';
      const postId = index + 1;

      return [
        '    <item>',
        `      <title>${escapeXml(title)}</title>`,
        `      <link>${escapeXml(result.url || '')}</link>`,
        `      <pubDate>${escapeXml(now)}</pubDate>`,
        `      <dc:creator><![CDATA[admin]]></dc:creator>`,
        `      <guid isPermaLink="false">${escapeXml(`sedscraper-post-${postId}`)}</guid>`,
        `      <description></description>`,
        `      <content:encoded><![CDATA[${escapeCdata(content)}]]></content:encoded>`,
        `      <excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
        `      <wp:post_id>${postId}</wp:post_id>`,
        `      <wp:post_date><![CDATA[]]></wp:post_date>`,
        `      <wp:post_date_gmt><![CDATA[]]></wp:post_date_gmt>`,
        `      <wp:comment_status><![CDATA[closed]]></wp:comment_status>`,
        `      <wp:ping_status><![CDATA[closed]]></wp:ping_status>`,
        `      <wp:post_name><![CDATA[${escapeCdata(slug)}]]></wp:post_name>`,
        `      <wp:status><![CDATA[draft]]></wp:status>`,
        `      <wp:post_parent>0</wp:post_parent>`,
        `      <wp:menu_order>0</wp:menu_order>`,
        `      <wp:post_type><![CDATA[post]]></wp:post_type>`,
        `      <wp:post_password><![CDATA[]]></wp:post_password>`,
        `      <wp:is_sticky>0</wp:is_sticky>`,
        '    </item>'
      ].join('\n');
    })
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
    items,
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
  return String(value || '').replaceAll(']]>', ']]]]><![CDATA[>');
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
