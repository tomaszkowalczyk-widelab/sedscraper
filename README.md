# SEDscraper

A small web app for scraping post data from a list of links.

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Usage

Paste links into the textarea, one URL per line, and click `Scrape`.
The backend fetches each page, extracts post metadata and cleaned post content, then returns the results in the interface. Results can be downloaded as CSV.
