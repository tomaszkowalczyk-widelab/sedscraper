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
  const attachmentPlan = createWordPressAttachmentPlan(posts);
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
      const postAttachments = attachmentPlan.byPostId.get(postId) || [];
      const blockContent = convertHtmlToWordPressBlocks(content, result.url, postAttachments);
      const featuredAttachment = postAttachments.find((attachment) => attachment.isFeatured);
      const thumbnailMeta = featuredAttachment
        ? createWordPressPostMeta('_thumbnail_id', String(featuredAttachment.id))
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
        `      <content:encoded><![CDATA[${escapeCdata(blockContent)}]]></content:encoded>`,
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
  const attachments = attachmentPlan.attachments
    .map((attachment) => createWordPressAttachmentItem(attachment, now))
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
    attachments,
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

      details.append(createCategoryTreeDetail(result.categories || []));
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

function createCategoryTreeDetail(categories) {
  const wrapper = document.createElement('div');
  wrapper.className = 'result-field full category-tree-field';

  const copyValue = formatCategoryHierarchy(categories) || 'No categories';
  const term = createFieldTerm('Categories', copyValue);

  const description = document.createElement('dd');
  if (!categories.length) {
    description.textContent = 'No categories';
  } else {
    description.append(createCategoryTree(categories));
  }

  wrapper.append(term, description);
  return wrapper;
}

function createCategoryTree(categories) {
  const tree = buildCategoryTree(categories);
  const list = document.createElement('ul');
  list.className = 'category-tree';

  tree.forEach((node) => {
    list.append(createCategoryTreeItem(node, 0));
  });

  return list;
}

function createCategoryTreeItem(node, depth) {
  const item = document.createElement('li');
  item.className = 'category-tree-item';
  item.style.setProperty('--depth', String(depth));

  const label = document.createElement('span');
  label.textContent = `${'-'.repeat(depth)}${depth ? ' ' : ''}${node.category.name || node.category.slug}`;
  item.append(label);

  if (node.children.length) {
    const list = document.createElement('ul');
    list.className = 'category-tree';
    node.children.forEach((child) => {
      list.append(createCategoryTreeItem(child, depth + 1));
    });
    item.append(list);
  }

  return item;
}

function buildCategoryTree(categories) {
  const nodesBySlug = new Map();
  const roots = [];

  categories.forEach((category) => {
    if (!category?.slug) return;

    nodesBySlug.set(category.slug, {
      category,
      children: []
    });
  });

  categories.forEach((category) => {
    if (!category?.slug) return;

    const node = nodesBySlug.get(category.slug);
    const parent = category.parentSlug ? nodesBySlug.get(category.parentSlug) : null;

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
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

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
        `      <wp:category_parent><![CDATA[${escapeCdata(term.parentSlug || '')}]]></wp:category_parent>`,
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
    .filter((category) => category.assigned !== false)
    .map((category) => {
      const term = normalizeWordPressExportTerm(category);
      if (!term.name) return '';

      return `      <category domain="category" nicename="${escapeXml(term.slug)}"><![CDATA[${escapeCdata(term.name)}]]></category>`;
    })
    .filter(Boolean)
    .join('\n');
}

function createWordPressAttachmentPlan(posts) {
  const attachments = [];
  const byPostId = new Map();
  let nextAttachmentId = posts.length + 1;

  posts.forEach((post, index) => {
    const postId = index + 1;
    const postAttachments = [];
    const seenUrls = new Set();

    getPostExportImages(post).forEach((image) => {
      if (!image.url || seenUrls.has(image.url)) return;

      seenUrls.add(image.url);

      const attachment = {
        ...image,
        id: nextAttachmentId,
        postId,
        post,
        title: image.alt || (image.isFeatured ? post.title : '') || getImageFilename(image.url)
      };

      nextAttachmentId += 1;
      attachments.push(attachment);
      postAttachments.push(attachment);
    });

    getPostExportFiles(post).forEach((file) => {
      if (!file.url || seenUrls.has(file.url)) return;

      seenUrls.add(file.url);

      const attachment = {
        ...file,
        id: nextAttachmentId,
        postId,
        post,
        title: file.title || getExportFilename(file.url)
      };

      nextAttachmentId += 1;
      attachments.push(attachment);
      postAttachments.push(attachment);
    });

    byPostId.set(postId, postAttachments);
  });

  return { attachments, byPostId };
}

function getPostExportImages(result) {
  const images = [];

  if (result.featuredImage?.src) {
    const url = normalizeExportImageUrl(result.featuredImage.src);

    images.push({
      url,
      alt: result.featuredImage.alt || '',
      isFeatured: true
    });
  }

  extractImagesFromHtml(result.postContent || result.articleContent || '', result.url).forEach((image) => {
    images.push({ ...image, isFeatured: false });
  });

  return images;
}

function getPostExportFiles(result) {
  const files = [];
  const transcriptUrl = normalizeExportFileUrl(result.transcriptLink || '');

  if (transcriptUrl) {
    files.push({
      url: transcriptUrl,
      title: getExportFilename(transcriptUrl),
      isFeatured: false,
      isImage: false,
      isTranscript: true
    });
  }

  return files;
}

function extractImagesFromHtml(html, baseUrl = '') {
  const images = [];
  const imagePattern = /<img\b[^>]*>/gi;
  let match;

  while ((match = imagePattern.exec(html || '')) !== null) {
    const tag = match[0];
    const rawSrc = extractHtmlAttribute(tag, 'src')
      || extractHtmlAttribute(tag, 'data-src')
      || extractFirstSrcsetUrl(extractHtmlAttribute(tag, 'srcset'))
      || extractFirstSrcsetUrl(extractHtmlAttribute(tag, 'data-srcset'));
    const url = normalizeExportImageUrl(resolveExportUrl(rawSrc, baseUrl));
    if (!url) continue;

    images.push({
      url,
      alt: extractHtmlAttribute(tag, 'alt')
    });
  }

  return images;
}

function convertHtmlToWordPressBlocks(html, baseUrl = '', attachments = []) {
  const blocks = [];
  const elementPattern = /<(p|h[1-6]|ul|ol|blockquote|figure)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let lastIndex = 0;
  let match;

  while ((match = elementPattern.exec(html || '')) !== null) {
    const looseHtml = String(html || '').slice(lastIndex, match.index).trim();
    if (looseHtml) blocks.push(convertLooseHtmlToBlock(looseHtml, baseUrl, attachments));

    blocks.push(convertElementHtmlToBlock(match[0], match[1].toLowerCase(), baseUrl, attachments));
    lastIndex = elementPattern.lastIndex;
  }

  const trailingHtml = String(html || '').slice(lastIndex).trim();
  if (trailingHtml) blocks.push(convertLooseHtmlToBlock(trailingHtml, baseUrl, attachments));

  return blocks.filter(Boolean).join('\n\n');
}

function convertElementHtmlToBlock(elementHtml, tagName, baseUrl = '', attachments = []) {
  if (tagName === 'p') {
    const imageBlock = convertImageOnlyHtmlToBlock(elementHtml, baseUrl, attachments);
    if (imageBlock) return imageBlock;

    return [
      '<!-- wp:paragraph -->',
      normalizeImagesInHtml(elementHtml, baseUrl, attachments),
      '<!-- /wp:paragraph -->'
    ].join('\n');
  }

  if (/^h[1-6]$/.test(tagName)) {
    const level = Number(tagName.slice(1));
    const attrs = level === 2 ? '' : ` {"level":${level}}`;

    return [
      `<!-- wp:heading${attrs} -->`,
      normalizeImagesInHtml(elementHtml, baseUrl, attachments),
      '<!-- /wp:heading -->'
    ].join('\n');
  }

  if (tagName === 'ul' || tagName === 'ol') {
    const attrs = tagName === 'ol' ? ' {"ordered":true}' : '';

    return [
      `<!-- wp:list${attrs} -->`,
      normalizeImagesInHtml(elementHtml, baseUrl, attachments),
      '<!-- /wp:list -->'
    ].join('\n');
  }

  if (tagName === 'blockquote') {
    return [
      '<!-- wp:quote -->',
      normalizeImagesInHtml(elementHtml, baseUrl, attachments),
      '<!-- /wp:quote -->'
    ].join('\n');
  }

  if (tagName === 'figure') {
    const imageBlock = convertImageOnlyHtmlToBlock(elementHtml, baseUrl, attachments);
    if (imageBlock) return imageBlock;

    return [
      '<!-- wp:html -->',
      normalizeImagesInHtml(elementHtml, baseUrl, attachments),
      '<!-- /wp:html -->'
    ].join('\n');
  }

  return convertLooseHtmlToBlock(elementHtml, baseUrl, attachments);
}

function convertLooseHtmlToBlock(html, baseUrl = '', attachments = []) {
  const imageBlock = convertImageOnlyHtmlToBlock(html, baseUrl, attachments);
  if (imageBlock) return imageBlock;

  return [
    '<!-- wp:html -->',
    normalizeImagesInHtml(html, baseUrl, attachments),
    '<!-- /wp:html -->'
  ].join('\n');
}

function convertImageOnlyHtmlToBlock(html, baseUrl = '', attachments = []) {
  const imgTag = String(html || '').match(/<img\b[^>]*>/i)?.[0] || '';
  if (!imgTag) return '';

  const textWithoutImage = cleanHtmlForImageBlockCheck(String(html || '').replace(imgTag, ''));
  if (textWithoutImage) return '';

  const rawSrc = extractHtmlAttribute(imgTag, 'src')
    || extractHtmlAttribute(imgTag, 'data-src')
    || extractFirstSrcsetUrl(extractHtmlAttribute(imgTag, 'srcset'))
    || extractFirstSrcsetUrl(extractHtmlAttribute(imgTag, 'data-srcset'));
  const src = normalizeExportImageUrl(resolveExportUrl(rawSrc, baseUrl));
  if (!src) return '';

  const alt = extractHtmlAttribute(imgTag, 'alt');
  const attachment = findAttachmentByUrl(attachments, src);
  const attrs = attachment
    ? ` {"id":${attachment.id},"sizeSlug":"large","linkDestination":"none"}`
    : ' {"sizeSlug":"large","linkDestination":"none"}';
  const imageClass = attachment
    ? `wp-image-${attachment.id}`
    : '';

  return [
    `<!-- wp:image${attrs} -->`,
    `<figure class="wp-block-image size-large"><img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}"${imageClass ? ` class="${imageClass}"` : ''}/></figure>`,
    '<!-- /wp:image -->'
  ].join('\n');
}

function normalizeImagesInHtml(html, baseUrl = '', attachments = []) {
  return String(html || '').replace(/<img\b[^>]*>/gi, (imgTag) => {
    const rawSrc = extractHtmlAttribute(imgTag, 'src')
      || extractHtmlAttribute(imgTag, 'data-src')
      || extractFirstSrcsetUrl(extractHtmlAttribute(imgTag, 'srcset'))
      || extractFirstSrcsetUrl(extractHtmlAttribute(imgTag, 'data-srcset'));
    const src = normalizeExportImageUrl(resolveExportUrl(rawSrc, baseUrl));
    if (!src) return imgTag;

    const attachment = findAttachmentByUrl(attachments, src);
    const normalized = setHtmlAttribute(imgTag, 'src', src);
    const withoutLazySources = removeHtmlAttributes(normalized, [
      'srcset',
      'data-src',
      'data-srcset',
      'sizes',
      'loading'
    ]);
    const classValue = [
      extractHtmlAttribute(withoutLazySources, 'class'),
      attachment ? `wp-image-${attachment.id}` : ''
    ].filter(Boolean).join(' ');

    return classValue
      ? setHtmlAttribute(withoutLazySources, 'class', classValue)
      : withoutLazySources;
  });
}

function findAttachmentByUrl(attachments, url) {
  return attachments.find((attachment) => !attachment.isFeatured && attachment.url === url)
    || attachments.find((attachment) => attachment.url === url)
    || null;
}

function cleanHtmlForImageBlockCheck(html) {
  return String(html || '')
    .replace(/<a\b[^>]*>|<\/a>/gi, '')
    .replace(/<figure\b[^>]*>|<\/figure>/gi, '')
    .replace(/<p\b[^>]*>|<\/p>/gi, '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&nbsp;/gi, '')
    .replace(/\s+/g, '')
    .trim();
}

function createWordPressAttachmentItem(attachment, fallbackDate) {
  const fileUrl = attachment.url || '';
  if (!fileUrl) return '';

  const fileDate = parseDateFromUploadUrl(fileUrl);
  const postDate = fileDate
    ? formatWordPressDateFromDate(fileDate)
    : formatWordPressDate(attachment.post.publishedDate || attachment.post.date, attachment.post.url, attachment.post.publishedDateGmt);
  const pubDate = postDate.rss || fallbackDate;
  const attachmentTitle = attachment.title || getExportFilename(fileUrl);
  const attachmentSlug = slugifyTerm(getExportFilename(fileUrl).replace(/\.[a-z0-9]+$/i, '') || attachmentTitle);
  const postParent = attachment.isFeatured ? attachment.postId : 0;

  return [
    '    <item>',
    `      <title>${escapeXml(attachmentTitle)}</title>`,
    `      <link>${escapeXml(fileUrl)}</link>`,
    `      <pubDate>${escapeXml(pubDate)}</pubDate>`,
    `      <dc:creator><![CDATA[admin]]></dc:creator>`,
    `      <guid isPermaLink="false">${escapeXml(fileUrl)}</guid>`,
    `      <description></description>`,
    `      <content:encoded><![CDATA[]]></content:encoded>`,
    `      <excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
    `      <wp:post_id>${attachment.id}</wp:post_id>`,
    `      <wp:post_date><![CDATA[${postDate.date}]]></wp:post_date>`,
    `      <wp:post_date_gmt><![CDATA[${postDate.dateGmt}]]></wp:post_date_gmt>`,
    `      <wp:post_modified><![CDATA[${postDate.date}]]></wp:post_modified>`,
    `      <wp:post_modified_gmt><![CDATA[${postDate.dateGmt}]]></wp:post_modified_gmt>`,
    `      <wp:comment_status><![CDATA[closed]]></wp:comment_status>`,
    `      <wp:ping_status><![CDATA[closed]]></wp:ping_status>`,
    `      <wp:post_name><![CDATA[${escapeCdata(attachmentSlug)}]]></wp:post_name>`,
    `      <wp:status><![CDATA[inherit]]></wp:status>`,
    `      <wp:post_parent>${postParent}</wp:post_parent>`,
    `      <wp:menu_order>0</wp:menu_order>`,
    `      <wp:post_type><![CDATA[attachment]]></wp:post_type>`,
    `      <wp:post_mime_type><![CDATA[${escapeCdata(getAttachmentMimeType(fileUrl))}]]></wp:post_mime_type>`,
    `      <wp:post_password><![CDATA[]]></wp:post_password>`,
    `      <wp:is_sticky>0</wp:is_sticky>`,
    `      <wp:attachment_url>${escapeXml(fileUrl)}</wp:attachment_url>`,
    createWordPressPostMeta('_wp_attached_file', getWordPressAttachedFilePath(fileUrl)),
    attachment.alt ? createWordPressPostMeta('_wp_attachment_image_alt', attachment.alt) : '',
    '    </item>'
  ].filter(Boolean).join('\n');
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
  const parentSlug = String(term?.parentSlug || '').trim();

  return { name, slug, parentSlug };
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

function extractHtmlAttribute(tagHtml, attributeName) {
  const pattern = new RegExp(`\\b${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = String(tagHtml || '').match(pattern);
  return match ? decodeHtmlEntities(match[2]).trim() : '';
}

function setHtmlAttribute(tagHtml, attributeName, value) {
  const safeValue = escapeHtmlAttribute(value);
  const pattern = new RegExp(`\\b${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'i');

  if (pattern.test(tagHtml)) {
    return tagHtml.replace(pattern, `${attributeName}="${safeValue}"`);
  }

  return tagHtml.replace(/\/?>\s*$/, (ending) => ` ${attributeName}="${safeValue}"${ending}`);
}

function removeHtmlAttributes(tagHtml, attributeNames) {
  return attributeNames.reduce((html, attributeName) => {
    const pattern = new RegExp(`\\s+${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'gi');
    return html.replace(pattern, '');
  }, tagHtml);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractFirstSrcsetUrl(srcset) {
  return String(srcset || '').split(',')[0]?.trim().split(/\s+/)[0] || '';
}

function resolveExportUrl(value, baseUrl = '') {
  const url = String(value || '').trim();
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return '';

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function normalizeExportImageUrl(value) {
  try {
    const url = new URL(value);

    if (url.hostname === 'i0.wp.com' || url.hostname === 'i1.wp.com' || url.hostname === 'i2.wp.com') {
      const pathParts = url.pathname.split('/').filter(Boolean);
      const originalHost = pathParts.shift();

      if (originalHost) {
        return `https://${originalHost}/${pathParts.join('/')}`;
      }
    }

    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

function normalizeExportFileUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return '';

  try {
    const parsedUrl = new URL(url);
    parsedUrl.hash = '';
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

function getWordPressAttachedFilePath(value) {
  try {
    const { pathname } = new URL(value);
    const match = pathname.match(/\/wp-content\/uploads\/(.+)$/);
    return decodeURIComponent(match?.[1] || pathname.split('/').filter(Boolean).at(-1) || 'image');
  } catch {
    return getImageFilename(value);
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

function formatWordPressDateFromDate(date) {
  return {
    date: formatWordPressDateTime(date),
    dateGmt: formatWordPressDateTime(date),
    rss: date.toUTCString()
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

function parseDateFromUploadUrl(value) {
  try {
    const { pathname } = new URL(value);
    const match = pathname.match(/\/wp-content\/uploads\/(\d{4})\/(\d{1,2})\//);
    if (!match) return null;

    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
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

function getAttachmentMimeType(value) {
  const extension = getExportFilename(value).split('.').pop()?.toLowerCase();
  const mimeTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    text: 'text/plain',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg'
  };

  return mimeTypes[extension] || 'application/octet-stream';
}

function getExportFilename(value) {
  try {
    const url = new URL(value);
    const filename = url.pathname.split('/').filter(Boolean).at(-1) || 'file';
    return decodeURIComponent(filename);
  } catch {
    return 'file';
  }
}

function formatSponsorLinks(links) {
  return links.map((link) => `${link.text || link.url}: ${link.url}`).join(' | ');
}

function formatTerms(terms) {
  return terms.map((term) => term.name || term.slug || String(term)).filter(Boolean).join(', ');
}

function formatCategoryHierarchy(categories) {
  const bySlug = new Map(
    categories
      .filter((category) => category?.slug)
      .map((category) => [category.slug, category])
  );

  return categories
    .map((category) => {
      const path = [];
      const seen = new Set();
      let current = category;

      while (current && !seen.has(current.slug || current.name)) {
        seen.add(current.slug || current.name);
        path.unshift(current.name || current.slug);

        current = current.parentSlug
          ? bySlug.get(current.parentSlug) || { name: current.parentName || current.parentSlug, slug: current.parentSlug }
          : null;
      }

      return path.filter(Boolean).join(' > ');
    })
    .filter(Boolean)
    .join(', ');
}

function htmlToText(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.textContent.replace(/\s+/g, ' ').trim();
}
